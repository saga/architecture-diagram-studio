# Auto layout 丢失几何包含关系（2026-10-28）

## 问题

图中一个小节点画在大圆角块内部，只靠几何位置表达"包含"，XML 中两者是同一 layer 下的兄弟节点（无 group、无 container 样式）。Auto layout 后小节点被甩到远处，包含关系丢失。

## 根因

布局器把每个顶层 vertex 交给 ELK 作为独立节点；只有被识别为"空间区域"的几何容器才会带着成员整体移动（`native-layout.ts` `v2/src/layout/native-layout.ts#L401-L419`）。该大块没有被识别为区域，内部节点就按连线自由摆放。

区域识别（`spatial-region-analysis.ts` `v2/src/layout/spatial-region-analysis.ts#L34-L36`）有三道门槛，此类容器会被前两道拦下：

1. **已连线的节点不能作为区域**（`connected.has`）。主因：规则假设区域是无连线的背景框，但架构图里的容器块通常自己就有连线。被排除后候选都不会产生。
2. **成员数 ≥ 3**（有 `container=1` / swimlane 等显式语义时 ≥ 2）。只含 1 个成员的容器过不了。
3. **面积 ≥ 16,000 且 ≥ 典型节点面积 × 5**。边界值，结果不稳定。

内部节点与大块之间若无连线，求解器看到的是互不连通的分量，会被分开打包；实测（ELK layered 默认参数）两者相距近 800px，`detectSpatialRegionsForLayout` 返回空候选，`spatialRegionCount = 0`。

## 次要发现

`parent` 为 group 而不是 layer 的连线不参与布线（`edgesOutsideLayoutLayerCount`），布局后保持旧几何，可能穿过其他节点或与标签重叠。同属"隐式结构被布局丢弃"，但与包含关系无关。

## 修复建议

遵循 ADR-0013：不改 XML 的 parent 关系，只调整求解时的临时投影。

1. **允许已连线的容器成为区域**：放宽 `connected` 排除，改为"面积显著大于成员且完整包含成员"。成员端点到区域 owner 的映射已存在（`layoutOwnerForTerminal` / `regionOwnerByMemberId`，`native-layout.ts#L422-L435`）。
2. **降低成员数门槛**：容器完整包含（ratio ≥ 0.85）≥ 1 个物理节点、面积 ≥ 成员 3 倍且自带文字标签时视为区域；保留重叠 / 嵌套 / 共享成员的跳过保护。
3. **兜底**：被完整包含却未识别为区域的节点，在 plan 的 coverage 中报告数量，避免静默丢失。
4. **测试**：在 `native-layout.test.ts` 与 `spatial-region-analysis.test.ts` 增加"已连线容器内含 1 个成员"用例：布局后成员相对容器偏移不变、外部连线仍指向 owner；现有 overlap / nested 用例不回归。
