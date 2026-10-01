# Changelog

本包遵循 [Semantic Versioning](https://semver.org/)，格式参考 [Keep a Changelog](https://keepachangelog.com/)。
0.x 阶段跨包依赖写 `>=x.y.z <1.0.0`（不用 `^`）。

## 0.0.3 — 2026-10-01

### 新增

- **`createDecisionHandler()` / `createDecisionHandlerFrom()`**：把一份 `.dmn` 包装成
  `@floken-io/engine` 的 `decisionHandler` SPI（`BusinessRuleTask` 的接线），
  补齐立项书 §6 **M4 判据①** 与 `04` §11 的 **DMN-D4**（「接入引擎 SPI」）。
  - **不 import 引擎**，只做形状兼容 —— 依赖方向铁律要求 dmn 的运行时依赖只有 `@floken-io/feel`；
    一 import 就把单向旁挂变成双向耦合（dmn 的 `.d.ts` 会带上引擎版本约束）。
  - 结果落点 `as` 三档：`'merge'`（默认）/ `'node'`（对齐引擎 `scriptTask` 的 D-59 落点）/ 自定义。
    引擎把 handler 的返回**原样并入** `variables`，不会自动包一层节点 id，故必须显式可选。
  - 解析与建索引只在构造时做一次（放 `evaluate` 里会让每次经过节点都重解析一遍 XML）。

### 修正

- `vite` 升为显式 `devDependency`：本包此前靠 npm 自动安装 vitest 的可选 peer，
  加了 `.npmrc`（`legacy-peer-deps`，规避 npm 10.9.7 的 `edgesOut` 崩溃）后不再自动装 ——
  不显式声明就会在重装依赖时丢掉 vite。

### 已知（未修，见 `known-gaps.md` §4）

- 两处**静默降级**：① 多列决策表 + 决策变量声明成标量类型 → 结果被压成 `null` 且无诊断；
  ② 输入变量缺失时两条互斥规则同时命中 → UNIQUE 报「命中策略被违反」。
  修它们会碰到 `@floken-io/feel` 的 null 语义与类型强制，可能动到 A 口径的分子，故先登记。

## 0.0.2 — 2026-09-27

### 文档

- README 补成对外文档：安装、决策表求值的最小示例、返回值契约
  （`{ value, trace, diagnostics }`）、DMN 命名空间写法、与 `floken-feel` 的分工。
- 修正 README 中两处与实现不符的表述（返回值字段名、命名空间尾斜杠）。

## 0.0.1 — 2026-09-27

首个发布版本。

### 完成

- **DMN 决策表求值**：`decide()` 走 `floken-feel` 求值，返回决策结果、
  决策链 trace 与诊断；输入类型不符按规范给 `null`（unknown），只有结果无定义才抛。
- **DMN 1.5 元模型**：导入接受 DMN 1.3~1.6（版本信号只认 `xmlns`），导出恒写 1.5。
- **官方 TCK 实测**：A 口径 3449/3449 通过（3467 条生效断言扣 18 条 IGNORED）。
