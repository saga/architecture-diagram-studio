# Draw.io 文档背景与网格被 Studio 主题色覆盖 — Root Cause 分析

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

## 7. 修复方向（未实施）

原则：主题只影响"画布以外的留白"，不覆盖"文档自己的页面"。

| 方案 | 做法 | 说明 |
|---|---|---|
| A（推荐） | 从 `drawio-theme.ts:73` 的选择器里去掉 `.geDiagramContainer svg`（必要时连 `#geDiagramContainer` 一起去掉），只保留 `body` | 留白区仍跟随主题，文档背景/网格由 drawio 自己绘制 |
| B | 保留选择器但改 `background-color: transparent` | 语义更明确，但容器透出 body 色，视觉结果与 A 接近 |
| C | 文档存在 `background` 时（`readDrawioModelBackground` 已实现）不注入该条规则 | 需要把"文档是否自带背景"传给 CSS 生成函数，逻辑更复杂 |

改完需要回归：
- 有自定义背景的文档 → 背景与网格保留；
- 无背景的文档 → 画布仍为主题色（不出现刺眼白块）；
- 四个主题（editorial / youth / warm / midnight）都不出现颜色断层；
- 导出 XML 与改前逐字节一致（本修复不应触碰文档）。

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
