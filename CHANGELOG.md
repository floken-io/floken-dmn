# Changelog

本包遵循 [Semantic Versioning](https://semver.org/)，格式参考 [Keep a Changelog](https://keepachangelog.com/)。
0.x 阶段跨包依赖写 `>=x.y.z <1.0.0`（不用 `^`）。

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
