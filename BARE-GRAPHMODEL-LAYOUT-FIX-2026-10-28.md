# 修复 mxGraphModel 导致 Auto layout 失败

日期: 2026-10-28

## 现象

打开元素为 `<mxGraphModel>`（无 `<mxfile>`）的文件后 Auto layout 报错并回滚："The active Draw.io page changed after layout calculation. Previous geometry was restored."，`<mxfile>` 文件正常。

## 根因

Studio 与 Draw.io 对裸模型的页面 ID 约定不一致：

- 解析器 [parseGraphModel](v2/src/layout/native-layout.ts) 原先对裸模型忽略传入的 `requestedPageId`，固定返回 `null`，布局计划的 `pageId` 因此为 `null`。
- Draw.io 运行时会为裸模型生成非空页面 ID，插件校验 [studio-selection-plugin](v2/plugins/studio-selection-plugin.js) 比对 `plan.pageId || null !== currentPageId() || null` → 不一致导致回滚。

App 只放行了"裸模型且运行时无页面 ID"（[App.tsx](v2/src/App.tsx) 的 `!pageId && !isBareNativeGraphModel(sourceXml)` 检查），未覆盖"裸模型但运行时生成了 ID"的情况。

## 修改

1. **核心修复**：`parseGraphModel` 对裸模型回传页面 ID `pageId: requestedPageId`。调用方已用 `inspectRuntime` 确认过该 ID，插件校验保持严谨；传 `null` 的现有行为不变。
2. **区域分析**：[App.tsx](v2/src/App.tsx) 对裸模型向 `spatialRegionAnalysisProvider.analyze` 传 `pageId: null`（区域分析要求裸模型必须用 `null`，非空 ID 会被判 invalid）；布局计划内部的 `detectSpatialRegionsForLayout` 调用同样如此。
3. **相同路径**：[useCopilotIntent.ts](v2/src/hooks/useCopilotIntent.ts) 对裸模型跳过 `pageInfo.id !== activePageId` 比较（裸模型无 envelope 页面 ID）；颜色预设的 `parseNativePageModel`（[drawio-theme.ts](v2/src/model/drawio-theme.ts)）对裸模型同样回传请求的页面 ID；`toNativeCellEdits` 的 `auto_layout` 校验（[native-edit-operations.ts](v2/src/model/native-edit-operations.ts)）对裸模型用请求的页面 ID 作为期望值。

不放宽插件的页面校验，也不在打开时把裸模型改写成 `<mxfile>`（违反 AGENTS.md 的 XML 保真约束）。

## 验证

[native-layout.test.ts](v2/src/layout/native-layout.test.ts) 已增加裸模型用例：传入页面 ID 时 `plan.pageId` 等于传入值；传 `null` 时仍为 `null`；两种情况的坐标与连线布点一致。

`npx tsc --noEmit` 通过；相关测试套件（native-layout、drawio-theme、spatial-region-analysis）全部通过。
