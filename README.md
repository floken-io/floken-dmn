# @floken/dmn

DMN **1.5** 决策引擎：让「规则」独立于流程图存在。

> 元模型权威版本 = **DMN 1.5**（★ Q35）。导入兼容 1.3 / 1.4 / 1.5 / 1.6，**导出恒写 1.5**。
> 完整需求见 `流程引擎包文档/04-包需求-floken-dmn.md`；实测分数与 IGNORED 清单见 `known-gaps.md`。

## 定位

- **权威版本 = DMN 1.5**（命名空间 `https://www.omg.org/spec/DMN/20230324/MODEL`，55 类型 / 121+ 自有属性；含 `typeConstraint`）。
- **导入双向兼容**：接受 **1.3 / 1.4 / 1.5 / 1.6** 四档命名空间，按文件声明识别；**导出恒写 1.5**。
  依据：四份 XSD 原件实测 OMG **只增不减**（零删除类型/属性/枚举）。
  ⚠️ 遇 1.6 专有特性（`importType="ONNX"`、B-FEEL `…/20240513/B-FEEL/`）**明确报错**，不静默降级。
- FEEL 表达式语言 URI = `https://www.omg.org/spec/DMN/20230324/FEEL/`（取自 `DMN15.xsd` 官方默认值；与官方 TCK 语料实测版本一致）。
- 表达式求值委托 `@floken/feel`（全量档 + temporal），**不自研任何求值**。
- 经 `decisionHandler` SPI **旁挂** `@floken/engine`，不进主链。

## 现状（2026-09-26 · M0 收官）

**官方 DMN TCK · A 口径（完整 DRG）：3449/3449（100%）**

| 项 | 数 |
|---|---|
| 断言总数（生效） | 3467 |
| IGNORED（0076 组，需真实 Java 类） | 18 |
| 计分基数 | **3449** |
| 通过 | **3449（100%）** |
| label 满分 | 53 / 53 |

分母链条可复算：语料全量 **3569** = 生效 **3467** + 官方 `<!-- -->` 注释禁用 **102**。
数字比较按**官方 runner 口径**（绝对差 `< 1e-8`，源码 + issue #609 双重依据），见 `known-gaps.md` §0。

## 用法

```ts
import { decide, decideOnly } from '@floken/dmn';

// 指定决策入口
const r = decide(xml, 'decision_001', { applicantAge: 18, risk: 'LOW' });
r.value;        // 决策结果
r.matchedRules; // 命中规则索引（可解释）
r.diagnostics; // 诊断（换输入有救的那类问题；其余抛错，见 AGENTS.md §5）

// 模型里只有一个决策时
const r2 = decideOnly(xml, { applicantAge: 18 });
```

低层 API：`readDmn` / `writeDmn`（XML↔模型）、`indexModel` / `evaluateDecision` / `evaluateAll`（DRG 编排）、`evaluateExpression`（单表达式）。

## 开发

```bash
pnpm install
pnpm build
pnpm verify        # 唯一门禁；含 A 口径 TCK（语料缺失则跳过该项）
pnpm tck           # 单独跑 A 口径
```
