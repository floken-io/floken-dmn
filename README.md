# floken-dmn

DMN 1.4 决策表引擎：让「规则」独立于流程图存在。

> 当前为骨架占位，实现见 `流程引擎包文档/04-包需求-floken-dmn.md`。

## 定位

- 元模型锁 **DMN 1.4**（命名空间 `https://www.omg.org/spec/DMN/20211108/MODEL`，55 类型 / 120+ 自有属性）。
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
