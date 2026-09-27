# @floken-io/dmn

[![npm](https://img.shields.io/npm/v/@floken-io/dmn)](https://www.npmjs.com/package/@floken-io/dmn)
[![license](https://img.shields.io/npm/l/@floken-io/dmn)](./LICENSE)

DMN **1.5** 决策引擎：让「规则」独立于流程图存在。

表达式求值委托 [`@floken-io/feel`](https://www.npmjs.com/package/@floken-io/feel)，不自研求值器。

## 安装

```bash
npm i @floken-io/dmn
```

## 快速开始

```ts
import { decide, decideOnly } from '@floken-io/dmn';

// 指定决策入口
const r = decide(xml, 'decision_001', { applicantAge: 18, risk: 'LOW' });
r.value;         // 决策结果
r.trace;         // 决策轨迹：[{ type: 'Decision', id, name, result }]
r.diagnostics;   // 诊断（换输入有救的那类问题；其余抛错）

// 模型里只有一个决策时
const r2 = decideOnly(xml, { applicantAge: 18 });
```

低层 API：`readDmn` / `writeDmn`（XML ↔ 模型）、`indexModel` / `evaluateDecision` / `evaluateAll`（DRG 编排）、`evaluateExpression`（单表达式）。

## 版本口径

- 元模型权威版本 = **DMN 1.5**（命名空间 `https://www.omg.org/spec/DMN/20230324/MODEL/`）
- **导入兼容 1.3 / 1.4 / 1.5 / 1.6**，按文件声明的命名空间识别
- **导出恒写 1.5**
- FEEL 表达式语言 URI = `https://www.omg.org/spec/DMN/20230324/FEEL/`

遇到 1.6 专有特性（`importType="ONNX"`、B-FEEL 命名空间）会**明确报错**，不静默降级。

## 标准符合性

用**官方 DMN TCK 全量**（含 DRG 遍历 / 决策表 / 命中策略）自证：

| 项 | 数 |
|---|---|
| 断言总数（生效） | 3467 |
| IGNORED（`0076` 组，需真实 Java 类） | 18 |
| **计分基数** | **3449** |
| **通过** | **3449（100%）** |
| label 满分 | 53 / 53 |

分母可复算：语料全量 **3569** = 生效 **3467** + 官方注释禁用 **102**。数字比较按官方 runner 口径（绝对差 `< 1e-8`）。

IGNORED 清单与判定规则见 [`known-gaps.md`](./known-gaps.md)。TCK 语料**不随包分发**（CC BY-SA 有传染性）。

## 相关包

| 包 | 用途 |
|---|---|
| [`@floken-io/feel`](https://www.npmjs.com/package/@floken-io/feel) | FEEL 表达式语言 |
| [`@floken-io/moddle`](https://www.npmjs.com/package/@floken-io/moddle) | BPMN 2.0 模型与 XML 转换 |
| [`@floken-io/dmn`](https://www.npmjs.com/package/@floken-io/dmn) | DMN 1.5 决策引擎（本包） |
| `@floken-io/engine` | 流程内核与审批动作（开发中） |
| `@floken-io/designer` | 流程画布与审批配置面板（开发中） |

## 开发

```bash
npm install
npm run build
npm run verify   # 发布门禁（含 TCK；语料缺失则跳过该项）
npm run tck      # 单独跑 TCK
```

## 许可证

[Apache-2.0](./LICENSE)
