/**
 * @floken-io/dmn · **`businessRuleTask` 的引擎侧适配器**（DMN-D4「接入引擎 SPI」）
 *
 * 把一份 `.dmn` 包装成 `@floken-io/engine` 的 `DecisionHandler` SPI 形状：
 *
 * ```ts
 * createEngine({ decisionHandler: createDecisionHandler(xml, { decision: '住宿标准表' }) });
 * ```
 *
 * ## ⚠️ 为什么这里**不 import `@floken-io/engine`**
 *
 * `AGENTS.md` §2 的依赖铁律写死 `dmn` 的运行时依赖只有 `@floken-io/feel`，
 * 且「dmn 不进主链」—— 引擎不装 dmn 也必须完整。若本文件去 import 引擎的
 * `DecisionHandler` 类型，就把一条**单向旁挂**改成了**双向耦合**：
 * 从此 dmn 的 `.d.ts` 里会带上引擎的版本约束，引擎改一次 SPI，dmn 就得跟着发版。
 *
 * 故这里做的是**形状兼容**而非类型依赖：`DecisionHandlerLike` 与引擎侧契约
 * **逐字段对齐**（`evaluate(input, ctx)` → `Promise<Record<string, unknown>>`，
 * `ctx` = `{ instanceId, nodeId, input }`）。对齐这件事由 `test/bridge.test.ts`
 * 用结构化断言钉死 —— 形状一旦漂移，测试红，不靠人记着。
 *
 * ## 结果落点（`as`）
 *
 * 引擎侧的契约是：`decisionHandler` 返回一个**变量补丁**，引擎原样并入 `variables`
 * （`assertVariablePatch`：必须是 plain object，数组 / null 直接抛 `STATE_SHAPE_INVALID`）。
 * 注意它**不会**像 `scriptTask` 那样自动包一层 `variables[nodeId]`（那是 D-59 给
 * FEEL 脚本定的落点）——补丁长什么样，由**本适配器**决定，故必须显式可选：
 *
 * - `'merge'`（默认）：决策值是对象 → 逐键并入（决策表多列输出直接变成多个变量，最常用）；
 *   决策值是标量 / `null` → 挂到**决策变量名**下（总得有个地方放，不能凭空消失）。
 * - `'node'`：`{ [ctx.nodeId]: value }` —— 与 `scriptTask` 的 D-59 落点对齐，
 *   同一个节点不管是跑脚本还是跑决策，结果都在同一个变量里。
 *
 * ## 诊断的出口（诚实标注）
 *
 * DMN 求值会产生 `diagnostics`（未命中任何规则、类型不符被降级等）。引擎的
 * `DecisionHandler` **没有诊断出口** —— 它的返回只有变量补丁，`PlanResult.diagnostics`
 * 装的是引擎自己的诊断，两者不能混。故：
 *
 * - 给了 `onDiagnostics` → 交给宿主（想记日志、想告警都随你）；
 * - **没给 → 诊断不落地**（不是"没发生"，是"没地方去"）。
 *
 * 与 `@floken-io/feel` 的 D-41（成功路径的 warnings 不上报）是同一类处境：
 * 「null 传播」在 DMN 里是**正常结果**而不是错误，为一个正常结果发明一个错误出口，
 * 比现在这样静默更糟。要可见就传回调 —— 这是宿主的选择，不该由本包替他决定。
 */

import { readDmn } from '../xml/reader.js';
import type { DmnElement } from '../xml/reader.js';
import { evaluateDecision, indexModel, resultName } from '../engine/drg.js';
import type { DecisionResult, ModelIndex } from '../engine/drg.js';
import { DecisionError } from '../core/errors.js';
import type { Diagnostic } from '../core/errors.js';

// ═══════════════════════════════════════════════════════════════
// 契约形状（与 `@floken-io/engine` 的 `DecisionHandler` 逐字段对齐）
// ═══════════════════════════════════════════════════════════════

/** 引擎调 `decisionHandler` 时给的上下文（与 `core/spi.ts` 的 `DecisionCtx` 同形） */
export interface DecisionHandlerCtx {
  instanceId: string;
  nodeId: string;
  input: Readonly<Record<string, unknown>>;
}

/**
 * 与引擎 `DecisionHandler` **同形**的契约。
 *
 * ⚠️ 刻意不 import 引擎类型（见档首）。`test/bridge.test.ts` 负责证明
 * 「这个形状能直接塞进 `createEngine({ decisionHandler })`」。
 */
export interface DecisionHandlerLike {
  evaluate(
    input: Record<string, unknown>,
    ctx: DecisionHandlerCtx,
  ): Promise<Record<string, unknown>>;
}

// ═══════════════════════════════════════════════════════════════
// 配置
// ═══════════════════════════════════════════════════════════════

/** 结果落点：`'merge'` / `'node'` / 自定义（见档首） */
export type DecisionResultShape =
  | 'merge'
  | 'node'
  | ((result: DecisionResult, ctx: DecisionHandlerCtx) => Record<string, unknown>);

export interface DecisionHandlerOptions {
  /**
   * 决策入口（id / 元素名 / 变量名，与 `decide()` 的第二参同口径）。
   * 不给 → 模型里的决策数**必须恰好为 1**，否则抛 `DMN_EVAL_NO_DECISION`（不猜）。
   * 传函数 → 按上下文决定（一个流程里不同节点跑不同决策表时用）。
   */
  decision?: string | ((ctx: DecisionHandlerCtx) => string) | undefined;
  /** 结果落点，默认 `'merge'` */
  as?: DecisionResultShape | undefined;
  /** DMN 诊断的出口；**不传 = 诊断不落地**（见档首「诊断的出口」） */
  onDiagnostics?: ((diagnostics: readonly Diagnostic[], ctx: DecisionHandlerCtx) => void) | undefined;
  /**
   * 透传 `@floken-io/feel` 的 `errorMode`，默认 `'null'`。
   * ⚠️ `'throw'` 不等于更正确：DMN 规范里 null 传播是正常结果，且实测会掉分。
   */
  errorMode?: 'null' | 'throw' | undefined;
}

// ═══════════════════════════════════════════════════════════════
// 工厂
// ═══════════════════════════════════════════════════════════════

/**
 * 从 `.dmn` **文本**建一个引擎侧 handler。
 *
 * ★ 解析与建索引**只在构造时做一次** —— 若放到 `evaluate` 里，流程每经过一次
 *   `businessRuleTask` 就要重新解析一遍 XML（并行分支上是 N 次），代价全在热路径上。
 */
export function createDecisionHandler(
  xml: string,
  options: DecisionHandlerOptions = {},
): DecisionHandlerLike {
  const { definitions, diagnostics } = readDmn(xml);
  return makeHandler(definitions, diagnostics, options);
}

/** 从**已解析**的 `definitions` 建 handler（宿主自己管 XML 时用这个） */
export function createDecisionHandlerFrom(
  definitions: DmnElement,
  options: DecisionHandlerOptions = {},
): DecisionHandlerLike {
  return makeHandler(definitions, [], options);
}

function makeHandler(
  definitions: DmnElement,
  parseDiagnostics: readonly Diagnostic[],
  options: DecisionHandlerOptions,
): DecisionHandlerLike {
  // 索引一次建好、之后复用（含 `<import>` 的传递展开）
  const index: ModelIndex = indexModel(definitions);
  let pending: readonly Diagnostic[] = parseDiagnostics;

  // 决策入口：不给就要求唯一（与 `decideOnly` 同款判据，不猜）
  let fixedDecision: string | undefined;
  if (typeof options.decision === 'string') {
    fixedDecision = options.decision;
  } else if (options.decision === undefined && index.decisions.length === 1) {
    const only = index.decisions[0];
    if (only === undefined || typeof only.$id !== 'string') {
      throw new DecisionError({
        code: 'DMN_EVAL_NO_DECISION',
        message: '模型里的唯一决策缺少 id，无法作为入口',
        details: { decisions: index.decisions.length },
        hint: '改用 options.decision 显式指定入口',
      });
    }
    fixedDecision = only.$id;
  }

  const shape: DecisionResultShape = options.as ?? 'merge';
  const errorMode = options.errorMode ?? 'null';

  return {
    async evaluate(input, ctx) {
      const decisionId =
        fixedDecision ??
        (typeof options.decision === 'function' ? options.decision(ctx) : undefined);

      if (decisionId === undefined || decisionId === '') {
        throw new DecisionError({
          code: 'DMN_EVAL_NO_DECISION',
          message: `businessRuleTask '${ctx.nodeId}' 未指定决策入口，且模型里的决策数不等于 1`,
          details: { nodeId: ctx.nodeId, decisions: index.decisions.length },
          hint: '传 options.decision（决策 id / 名字 / 变量名，或 (ctx) => id）',
        });
      }

      const result = evaluateDecision(definitions, decisionId, input ?? {}, {
        index,
        errorMode,
      });

      // 解析期诊断只随**第一次**求值交出去（一次解析对应一条事实，不该每个令牌报一遍）
      const diags: readonly Diagnostic[] =
        pending.length > 0 ? [...pending, ...result.diagnostics] : result.diagnostics;
      pending = [];
      if (diags.length > 0 && options.onDiagnostics !== undefined) {
        options.onDiagnostics(diags, ctx);
      }

      return shapeOf(shape, result, decisionId, ctx, index);
    },
  };
}

function shapeOf(
  shape: DecisionResultShape,
  result: DecisionResult,
  decisionId: string,
  ctx: DecisionHandlerCtx,
  index: ModelIndex,
): Record<string, unknown> {
  if (typeof shape === 'function') return shape(result, ctx);
  if (shape === 'node') return { [ctx.nodeId]: result.value };

  // 'merge'：对象逐键并入；标量 / null 挂到决策变量名下（不能凭空消失）
  const v = result.value;
  if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
    return { ...(v as Record<string, unknown>) };
  }
  return { [nameOf(index, decisionId)]: v };
}

/**
 * 标量结果挂哪个键 —— 取决策的**变量名**（它是 DMN 里「结果叫什么」的正式答案），
 * 退到元素名，再退到入参本身。
 */
function nameOf(index: ModelIndex, decisionId: string): string {
  const el =
    index.byId.get(decisionId) ??
    index.byName.get(decisionId) ??
    index.byVariable.get(decisionId);
  if (el === undefined) return decisionId;
  return resultName(el) || decisionId;
}
