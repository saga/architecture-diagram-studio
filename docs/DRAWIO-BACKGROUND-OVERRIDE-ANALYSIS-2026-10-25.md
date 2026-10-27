# Draw.io 文档背景与网格被 Studio 主题色覆盖 — Root Cause 分析

**原始 CSS 覆盖 bug 已修复；当前配色规则见 ADR-0023。** Studio 不向 iframe 注入会遮住网格的不透明背景 CSS。主题预设通过原生 Draw.io 模型事务修改节点/连线颜色，并清除当前页显式设置的 `background` 属性，回到 Draw.io 默认画布；网格继续由 Draw.io 原生渲染，其他页面不受影响。留白是有意的可读性选择，不再为十套配色强加浅色背景。下文保留原始根因证据，供回归检查使用。

日期：2026-10-25
范围：`v2/src/model/drawio-theme.ts`、`v2/src/components/DrawioFrame.tsx`、`v2/plugins/studio-selection-plugin.js`、`v2/public/drawio/js/grapheditor/Editor.js`
样例文件：`~/Downloads/investment-research-platform.drawio`
结论：**文档 XML 没有被修改。是 Studio 注入 iframe 的展示层 CSS 在图形 SVG 上盖了一层不透明底色，把 drawio 画在下一层的页面背景色与网格图遮住了。**

---

## 1. 现象

| | 原始（drawio / 导出） | 在 Studio 内打开 |
|---|---|---|
| 页面背景 | `#FFFF66` 黄色 | 主题 canvas 色（editorial `#F3F5F9` / warm paper `#FFFCF6`） |
| 网格 | 4px 网格可见 | 完全不可见 |
| 图形 / 连线 / 缩放 | — | 完全一致，未被改动 |

用户判断"打开就改了背景"，但保存/导出不受影响——只有呈现层变了。

## 2. 先排除数据损坏

磁盘上的文件属性完好：

```xml
<mxGraphModel grid="1" gridSize="4" ... background="light-dark(#FFFF66,#121212)" ...>
```

- `background` 还在，而且是 `light-dark()` 双值（亮色 `#FFFF66` / 暗色 `#121212`）；
- `grid="1"` 还在；
- Studio 的保存链路（`mxCodec` 序列化 + 服务端写盘）没有丢属性。

所以问题不在 import / 序列化 / 版本恢复，而在渲染。

## 3. drawio 的绘制分层

`public/drawio/js/grapheditor/Editor.js:4007` `mxGraphView.prototype.validateBackgroundStyles` 决定背景与网格画在哪：

| 层级 | 元素 | 内容 | 设置方式 |
|---|---|---|---|
| 上 | `graph.view.canvas`（图形 SVG） | 节点、连线 | — |
| 下 | `.geBackgroundPage`（页面可见时，`:4084`） | 页面背景色 + 网格图 | **内联** `style.backgroundColor` / `style.backgroundImage` |
| 下（无页面时，`:4117`） | 同一个图形 SVG 的 `canvas` | 背景色 + 网格图 | **内联** `style.backgroundColor` / `style.backgroundImage` |

关键点：**背景色和网格图是同一层、同一个元素上的一对 CSS 属性**。盖住这一层，两者一起消失——这正是"黄色没了、网格也没了"的原因。

## 4. Root cause

`v2/src/model/drawio-theme.ts:73-75`：

```css
body, #geDiagramContainer, .geDiagramContainer, .geDiagramContainer svg {
  background-color: ${canvas} !important;
}
```

这段 CSS 由 `DrawioFrame.tsx:321-326` 以 `studioPresentationThemeRequest` 发给 iframe，`plugins/studio-selection-plugin.js:1067-1075` 写入 `<style id="studio-native-theme">`。

`.geDiagramContainer svg` 命中的正是上层的图形 SVG。它被强制刷成不透明主题色后：

- 下层 `.geBackgroundPage` 的黄色被完全遮住；
- 网格图（与背景色同在 `.geBackgroundPage` 的内联 `background-image`）一并被遮住；
- 可见颜色 = 主题 canvas 色，与用户截图一致。

`!important` 是关键：drawio 用的是**内联样式**，正常情况下内联优先级高于样式表，但样式表里的 `!important` 会反超内联，所以覆盖成立。

`DrawioFrame.tsx:604` 的注释 "Theme is presentation-only; do not modify Draw.io graph background on init" 说明代码有意不去动 `graph.background`——但这段 CSS 在视觉上达成了同样的效果，属于同一意图的另一种实现路径，被漏掉了。

## 5. 证据链

### 5.1 运行时：文档背景其实被正确应用了

在真实 Studio（`http://127.0.0.1:5174`）里用 Playwright 读取 iframe 计算样式：

```
WITH THEME    pageShape.bg = rgb(255, 255, 102)   ← 文档的黄色，仍在
              pageShape.inline = light-dark(rgb(255,255,102), rgb(18,18,18))
              body.bg = rgb(255, 252, 246)        ← 主题色
WITHOUT THEME pageShape.bg = rgb(255, 255, 102)
              body.bg = rgb(241, 243, 244)
```

`.geBackgroundPage` 一直是黄色 → drawio 正确应用了 `background`，只是被上层不透明 SVG 挡住。

### 5.2 A/B：只删一个 style 元素就恢复

同一份文件、同一个编辑器、同一缩放（55%），仅执行：

```js
document.querySelector("#studio-native-theme")?.remove();
```

- 删除前：整块画布是主题色，无网格；
- 删除后：黄色背景 + 4px 网格立即出现，图形位置/样式完全不变。

### 5.3 像素采样：不是"网格太淡"

对 Studio 截图横向采样 1272px：

```
row50  → [["243,245,249", 1272]]     整行单一颜色
row300 → [["243,245,249", 1061], ["255,255,255", 204], ...]
```

若只是网格颜色浅，采样会出现周期性色差；实测是**零色差**，证明网格层根本没被绘制/可见。

## 6. 影响面

1. 所有自定义页面背景的文档（任意色、`light-dark()` 的亮/暗双值）在 Studio 内都显示为主题色；
2. 网格线对所有文档都不显示（`grid="1"` 形同虚设）；
3. 深色主题下 `light-dark()` 的暗色分支同样被覆盖，暗色文档背景也失效；
4. **不损坏数据**：保存、导出、版本历史里的 XML 都是正确的；问题只在嵌入编辑器的呈现层。

## 7. 修复实现与回归检查

原始 CSS 覆盖修复以 ADR-0020 为准，当前配色背景规则以 ADR-0023 为准：

- 删除 DrawioFrame 中发送 studioPresentationThemeRequest 的 effect，插件不再创建或更新 studio-native-theme 样式表。
- 不再对 SVG、图形容器或页面元素注入不透明主题背景；背景色和网格继续使用 Draw.io 原生页面配置。
- 颜色预设直接更新原生 XML 中顶点的 fillColor / strokeColor / fontColor 与连线的 strokeColor / fontColor，适用于压缩和未压缩页面。
- 选择预设不切换 Studio 应用主题；按照 ADR-0023，主题清除当前页的 `mxGraphModel background` 属性而不是写入另一种浅色底，grid/gridSize 保持不变。清除背景和节点/连线颜色进入同一个原生 Undo/Redo、保存和版本历史路径；Undo 精确恢复此前显式背景。

回归检查：

- 带自定义背景的文档：选择配色预设会清除当前页的显式背景；Undo 恢复原色，网格始终由 Draw.io 原生绘制。
- 无显式 background 的文档：画布留白仍由 Draw.io 默认行为绘制，不被全局主题 CSS 覆盖。
- 应用主题保持不变；节点/连线颜色写入 XML，重新打开后仍存在。
- 导出 XML 中当前页不再保留旧的主题/自定义 `background` 属性；`grid`、`gridSize`、几何、标签和非颜色样式不变。

## 8. 复现脚本（可选）

Playwright 打开真实 Studio，拦截所有 `/api/workspace/**` 写请求，避免污染工作区：

```js
await page.route("**/api/workspace/**", (route) =>
  route.request().method() === "GET" ? route.continue() : route.abort());

await page.goto("http://127.0.0.1:5174/");
const frame = page.frames().find((f) => f.url().includes(":4176/"));

await page.evaluate((xml) => {
  document.querySelector('iframe[title="Native Draw.io editor"]')
    .contentWindow.postMessage(JSON.stringify({ action: "load", xml, autosave: 0 }), "http://127.0.0.1:4176");
}, readFileSync(file, "utf8"));

// 开/关主题样式，各截一张图对比
await frame.evaluate(() => document.querySelector("#studio-native-theme")?.remove());
```

注意：`autosave: 0` + 拦截写请求，避免测试文档被写回用户工作区。
