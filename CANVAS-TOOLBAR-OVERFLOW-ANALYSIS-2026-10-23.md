# Canvas Toolbar 被 "Stress · relationships" 撑破 — Root Cause 分析

日期：2026-10-23
范围：`v2/src/App.tsx` 顶部 `canvas-toolbar`、`v2/src/styles.css`
结论：不是 Draw.io 的问题，也不是 ELK 的问题；是 **antd Select 用 `min-width` 导致控件宽度随"选中项文字"变化**，叠加 **toolbar 无条件 `flex-wrap: wrap`**，在可用宽度只差 3px 时把 `Advanced` 挤到第二行。

---

## 1. 现象

选择 `Algorithm = Stress · relationships` 后：

```
[Draw.io diagram]
[Layout engine ▾] [Algorithm ▾] [Direction ▾] [Horizontal] [Vertical] [Auto layout]
                                                                      [Advanced]
```

- 头部从 1 行变 2 行，`Advanced` 单独一行、右对齐悬空；
- 整个控件组向右移动约 80px（`justify-content: flex-end` 的留白全堆到左侧）；
- 头部高度增加约 40px，Draw.io 画布可用高度减少。

## 2. Root cause（按因果链）

### 2.1 直接触发：Select 宽度由"选中项文字"决定

`styles.css:82-83`（改动前）：

```css
.native-layout-select { min-width: 132px; font-size: 11px; }
.native-layout-direction.ant-select { min-width: 125px; }
```

antd Select 没有固定 `width` 时是内容自适应（`inline-block`），`min-width` 只是下限：

| 选中项 | 字符数 | 控件实际宽度 |
|---|---|---|
| `Layered · flow` | 14 | 132px（min-width 生效） |
| `Force · organic` | 15 | ~132px |
| `Stress · relationships` | **22** | **~170px（+38px）** |

`Stress · relationships` 是 `NATIVE_LAYOUT_ALGORITHMS`（`App.tsx:34`）里最长的一项，也是唯一会撑破 `min-width` 的一项。所以只有它出问题，"Force · organic" 不出问题。

### 2.2 放大器：头部本来就没有余量

截图中主面板内容宽约 1005px（左右各 25px padding）：

- 静态标题 `Draw.io diagram` 占 ~150px + 15px gap；
- 控件行（含 Stress）实际宽度 ≈ 923px；
- 可用 1005px，右对齐后左侧留白 82px；
- `Advanced` 需要 ~78px + 7px gap = **85px > 82px**。

**只差 3px。** 换成 `Layered · flow` 时该行约 885px，加 `Advanced` 共 970px，放得下。这就是"只有选 Stress 才崩"的量化原因。

### 2.3 结构原因：toolbar 允许换行，且换行后右对齐

`styles.css:844`（改动前，由提交 `192d382 fix(studio): keep sidebars inside their tracks on narrow viewports` 引入）：

```css
.canvas-toolbar { flex-wrap: wrap; row-gap: 10px; }   /* 无媒体查询，所有宽度生效 */
```

`styles.css:79`（改动前）：

```css
.canvas-toolbar-actions { justify-content: flex-end; flex-wrap: wrap; }
```

→ 溢出时不是压缩/截断，而是"换行"；换行后每个 flex line 各自 `flex-end`，于是 `Advanced` 单独成行并贴右，视觉上像错位而不是有意的两行布局。

### 2.4 隐性原因：全局 `!important` 字号把紧凑布局放大了 ~18%

`styles.css:919-926`：

```css
.app-shell, .app-shell * { font-size: var(--font-normal) !important; }  /* 13px */
```

所以 `.native-layout-field { font-size: 11px }`、`.native-layout-select { font-size: 11px }` 全部失效，label 与选项实际按 13px 渲染。设计意图的 11px 紧凑工具条从未生效，整行比预期宽约 15%~18%——这是"本来就快放不下"的根源。

### 2.5 时间线

| 提交 | 影响 |
|---|---|
| `192d382` (10-21) | 为窄视口修复给 `.canvas-toolbar` 加了**无条件** `flex-wrap: wrap` |
| `1c9104f` (10-23) | 恢复 native 布局控件，Select 只给 `min-width`，没有固定 `width` |

两者叠加 → 长选项一选就换行。

## 3. 已实施的修复

### 3.1 删除静态标题（`App.tsx:1148`）

```diff
 <div className="canvas-toolbar">
-  <div className="canvas-title">Draw.io diagram</div>
   <div className="canvas-toolbar-actions" role="group" aria-label="Layout controls">
```

同时移除 `.canvas-title` 的 3 处 CSS（样式定义、主题文字色、大字号白名单）。

### 3.2 Select 改为固定宽度（`styles.css:83-85`）

```css
.native-layout-select { width: 132px; flex: 0 0 auto; font-size: 11px; }
.native-layout-algorithm.ant-select { width: 168px; }
.native-layout-direction.ant-select { width: 136px; }
```

选中项再长也不会改变控件宽度 → 布局与选择无关，`Stress` 与 `Layered` 完全一致。
`App.tsx` 中 algorithm 的 Select 由复用的 `native-layout-engine` class 改为独立的 `native-layout-algorithm`（原 class 是复制粘贴残留，且没有任何 CSS 命中它）。

### 3.3 控件组左对齐（`styles.css:77-78`、`846`）

标题删除后 `space-between` 只剩一个子元素，控件会被推到左边；改为 `justify-content: flex-start`，与下方 Draw.io 自带工具条（绘图/形状/格式…）左对齐。
`row-gap` 统一为 7px，窄视口换行时两行左对齐、间距一致，不再出现"悬空贴右"。

### 3.4 保留换行，但只作为窄视口兜底

`.canvas-toolbar { flex-wrap: wrap }` 保留（≤1120px 的媒体查询本来也有），但不再是"任何溢出都换行"的唯一出口——因为宽度已经固定。

## 4. 验证

- `tsc --noEmit`：通过
- `vitest run`：23 个文件 / 228 个测试全部通过
- 无 e2e / 单测引用 `canvas-title` 或该标题文案（已 grep 确认），删除无回归

## 5. 遗留建议（未改，需产品决策）

1. **`Stress · relationships` 在 168px 下仍会截断**（需要 ~170px）。两个选项：
   - 把选项文案简化为 `Layered` / `Mr. Tree` / `Radial` / `Stress` / `Force`（`· flow` 之类的提示是装饰性的，Direction 选择器已经表达方向语义）——推荐，可同时省下 ~40px；
   - 或把 algorithm 宽度提到 176px（会吃掉全部剩余余量，窗口再窄就重新换行）。
2. **`Horizontal` / `Vertical` 按钮与 `Direction` 选择器 + `Auto layout` 功能重复**，占 ~160px。若要给工具条留出真正余量，这是最划算的删除项。
3. **全局 `!important` 字号规则**应改为在组件层声明字号，否则所有"紧凑"设计意图都会被 13px 覆盖。
4. 死 CSS：`.canvas-kicker`、`.canvas-subtitle`、`.canvas-tools` 已无任何 JSX 引用，可一并清理。

## 6. 关于 "Draw.io diagram" 这个标题

**没有功能价值，已删除。**

- 它是**硬编码字符串**（`App.tsx:1149`），不绑定文件名、不绑定当前页、不随状态变化，任何情况下都显示同样的字；
- 真正的文档标识在顶栏面包屑 `document-breadcrumb`（`App.tsx:1081`，显示 `standaloneFileName || primaryDiagram`）；
- 但它常驻占据工具条 ~165px，是本问题的直接"帮凶"。

补充：顶栏面包屑在 **≤1600px 时会把文件名隐藏**（`styles.css:839-843`）。所以如果希望头部承担"当前文件"的信息，正确做法不是恢复这个静态标题，而是绑定真实名称：

```tsx
<div className="canvas-title">{standaloneFileName || projectWorkspace?.primaryDiagram || "Untitled diagram"}</div>
```

当前按"无用即删"处理；如需恢复，请按上面绑定动态值。
