// 表达式求值委托 —— **本包不得自己实现任何求值**（`04-dmn` §14 边界第 1 条）。
//
// 只做三件事：
//  1. 把字符串 + 变量字典交给 `floken-feel`（边界第 2 条：不许把 dmn 元素对象塞进去）；
//  2. 把 `floken-feel` 的结构化错误包装成 `DMN_EVAL_FEEL`（保留 cause，不吞异常 —— §5.6）；
//  3. DMN `typeRef` → FEEL 值的类型强制（决策表输入/输出列的声明类型）。
import { evaluate, unaryTest, type Diagnostic as FeelDiagnostic } from 'floken-feel';
import { DecisionError, type Diagnostic } from '../core/errors.js';

/** 普通对象 → FEEL context（盒装 context 的结果值，与 FEEL 里 `{a: 1}` 同一种值） */
export { toFeelContext } from 'floken-feel';

// --------------------------------------------------------------------------
// FEEL 委托
// --------------------------------------------------------------------------

export interface FeelOutcome {
  value: unknown;
  warnings: Diagnostic[];
}

/** feel 的诊断 → 本包诊断（`code` 保持 feel 原码，便于溯源） */
function toDiagnostics(warnings: readonly FeelDiagnostic[] | undefined): Diagnostic[] {
  const out: Diagnostic[] = [];
  for (const w of warnings ?? []) {
    out.push({
      severity: w.severity === 'error' ? 'error' : w.severity === 'info' ? 'info' : 'warn',
      code: w.code,
      message: w.message,
      start: w.start,
      end: w.end,
      ...(w.expected ? { expected: w.expected } : {}),
    });
  }
  return out;
}

/**
 * 求值一个 FEEL 表达式。
 *
 * 错误通道（§5.1）：
 *  - **语法/API 契约类**由 `floken-feel` 直接抛 → 这里包装成 `DMN_EVAL_FEEL`
 *    （带 `node` 定位与 `cause`，不吞、不转 null —— NFR-M4）；
 *  - **语义降级**（变量缺失等）随 `warnings` 返回，不抛。
 */
export function evalExpression(src: string, context: Record<string, unknown>, node?: { id?: string; path?: string }): FeelOutcome {
  try {
    const r = evaluate(src, context);
    return { value: r.value, warnings: toDiagnostics(r.warnings) };
  } catch (e) {
    throw new DecisionError({
      code: 'DMN_EVAL_FEEL',
      message: 'FEEL 表达式求值失败',
      ...(node ? { node } : {}),
      hint: '见 cause 中的 floken-feel 错误码与定位',
      details: { expression: src },
      cause: e,
    });
  }
}

/**
 * 求值一条 unary tests（决策表输入条目）。被验值绑在 `?` 上。
 * @returns `true` 命中；`false` 不命中；`null` = 未知（三值逻辑，不是错误 —— §5.6）
 */
export function evalUnaryTests(src: string, value: unknown, context: Record<string, unknown>, node?: { id?: string; path?: string }): { value: boolean | null; warnings: Diagnostic[] } {
  try {
    const r = unaryTest(src, { ...context, '?': value });
    return { value: r.value === true ? true : r.value === false ? false : null, warnings: toDiagnostics(r.warnings) };
  } catch (e) {
    throw new DecisionError({
      code: 'DMN_EVAL_FEEL',
      message: 'FEEL unary tests 求值失败',
      ...(node ? { node } : {}),
      hint: '见 cause 中的 floken-feel 错误码与定位',
      details: { expression: src },
      cause: e,
    });
  }
}

// --------------------------------------------------------------------------
// DMN typeRef → 值的类型强制
// --------------------------------------------------------------------------

/** DMN 基本类型（FEEL 内建类型名，小写） */
const BASE_TYPES = new Set([
  'number',
  'string',
  'boolean',
  'date',
  'time',
  'date and time',
  'dateTime',
  'days and time duration',
  'years and months duration',
  'Any',
  'any',
]);

export function isBaseTypeRef(typeRef: unknown): boolean {
  return typeof typeRef === 'string' && BASE_TYPES.has(typeRef);
}

/**
 * 按 `typeRef` 强制转换一个值。
 *
 * 口径：
 *  - `typeRef` 缺席或是 `Any` → 原样返回（DMN 允许不声明类型）；
 *  - 基本类型 → 交给 FEEL 做转换（复用同一套语义，不自造一套 —— 边界第 1 条）；
 *  - 复合类型（`itemDefinition` 名）→ **不做结构化构造**，保持原值
 *    （结构由盒装表达式自己产出，强行构造会引入本包不该有的语义）。
 */
export function coerceTypeRef(value: unknown, typeRef: unknown, node?: { id?: string; path?: string }): unknown {
  if (typeRef === undefined || typeRef === null || typeRef === '' || typeRef === 'Any' || typeRef === 'any') return value;
  if (!isBaseTypeRef(typeRef)) return value;
  if (value === null || value === undefined) return null;

  const fn = TYPE_COERCIONS[typeRef as string];
  if (!fn) return value;
  try {
    const r = evaluate(fn, { v: value });
    return r.value;
  } catch {
    // 转换失败按 §5.6「禁用 null 表达出错」：抛，而不是静默给 null
    throw new DecisionError({
      code: 'DMN_EVAL_TYPE_CONSTRAINT',
      message: '值无法转换为声明的 typeRef',
      ...(node ? { node } : {}),
      details: { typeRef },
    });
  }
}

/** 各基本类型的转换表达式（`v` 是被转换值） */
const TYPE_COERCIONS: Record<string, string> = {
  number: 'number(v)',
  string: 'string(v)',
  boolean: 'boolean(v)',
  date: 'date(v)',
  time: 'time(v)',
  dateTime: 'date and time(v)',
  'date and time': 'date and time(v)',
  'days and time duration': 'duration(v)',
  'years and months duration': 'duration(v)',
};
