# floken-dmn

DMN **1.6** 决策表引擎：让「规则」独立于流程图存在。

> 当前为骨架占位，实现见 `流程引擎包文档/04-包需求-floken-dmn.md`。

## 定位

- **权威版本 = DMN 1.5**（命名空间 `https://www.omg.org/spec/DMN/20230324/MODEL`，55 类型 / 121+ 自有属性；含 `typeConstraint`）。
- **导入双向兼容**：接受 **1.3 / 1.4 / 1.5 / 1.6** 四档命名空间，按文件声明识别；**导出恒写 1.5**（★ Q35，2026-09-26；
  此前 Q34 的「只认 1.6、旧版直接报错」已撤销）。依据：四份 XSD 原件实测 OMG **只增不减**（零删除类型/属性/枚举）。
   ⚠️ 遇 1.6 专有特性（`importType="ONNX"`、B-FEEL `…/20240513/B-FEEL/`）**明确报错**，不静默降级。
- FEEL 表达式语言 URI = `https://www.omg.org/spec/DMN/20230324/FEEL/`（取自 `DMN15.xsd` 官方默认值；与官方 TCK 语料实测版本一致）。
- 表达式求值委托 `floken-feel`（全量档 + temporal），**不自研任何求值**。
- 经 `decisionHandler` SPI **旁挂** `floken-engine`，不进主链。

## 开发

```bash
pnpm install
pnpm build
pnpm verify
```

## 目标

TCK CL3 全绿（目标 3391/3391，A 口径）。
