// floken-dmn —— DMN 1.5 决策引擎。
//
// 分层（AGENTS.md §4.1）：`core` ← 域（`spec` / `xml` / `engine`）← 入口。
//
// 依赖（Q35 / Q38）：
//  - 表达式求值**全部**委托 `floken-feel`（`04-dmn` §14 边界第 1 条）；
//  - XML 读写自研，不引第三方 XML 库（Q38）；
//  - 权威元模型版本 **DMN 1.5**，导入兼容 1.3/1.4/1.5/1.6，导出恒写 1.5（Q35）。
import 'floken-feel/temporal'; // ★ 延迟能力档（§5.8）：DMN 全量档必须含时态语义

import { readDmn } from './xml/reader.js';
import { evaluateDecision, indexModel, resultName, type DecisionResult } from './engine/drg.js';
import { DecisionError } from './core/errors.js';

export const PACKAGE = 'floken-dmn' as const;

export {
  DecisionError,
  DmnError,
  DmnModelError,
  DmnOptionError,
  DmnXmlError,
  DMN_ERROR_CLASSES,
  DMN_ERROR_CODES,
  DMN_DIAGNOSTIC_CODES,
  isDmnError,
} from './core/errors.js';
export type { Diagnostic, DmnErrorCode, DmnDiagnosticCode } from './core/errors.js';

// --- 元模型 ---
export {
  ACCEPTED_NAMESPACES,
  EXPORT_NAMESPACE,
  EXPORT_VERSION,
  FEEL_URI_20230324,
  NS_20230324,
  NS_20240513,
  SPEC_STATS,
  allProperties,
  descendantsOf,
  getType,
  isSubtypeOf,
  versionOfNamespace,
} from './spec/index.js';
export type { SpecProperty, SpecType } from './spec/spec-types.js';

// --- XML 读写 ---
export { parseXml } from './xml/sax.js';
export type { XmlNode } from './xml/sax.js';
export { readDmn, indexById, isElement } from './xml/reader.js';
export type { DmnElement, ReadResult } from './xml/reader.js';
export { writeDmn } from './xml/writer.js';
export type { WriteOptions } from './xml/writer.js';

// --- 求值 ---
export { evaluateDecision, evaluateAll, indexModel, resultName } from './engine/drg.js';
export type { DecisionResult, ModelIndex, TraceEntry, ImportBinding, IndexOptions } from './engine/drg.js';
export { evaluateExpression } from './engine/expression.js';
export type { EvalScope } from './engine/expression.js';

export interface DecideOptions {
  /** 预建索引（重复调用同一模型时省一次遍历） */
  index?: ReturnType<typeof indexModel>;
  /**
   * ★ 透传 `floken-feel` 的 **`errorMode`**（默认不设 = `'null'`）：
   *  - `'null'`（默认）：未知/类型不符 → `null` + 诊断（返回值 `diagnostics` 里带定位）；
   *  - `'throw'`：未知也抛 `DMN_EVAL_FEEL`（fail-fast，第一个错就中断）。
   *
   * ⚠️ `'throw'` 不等于"更正确"：DMN 规范里 null 传播是正常结果。实测 A 口径在它下面
   * 会掉 1 条（`0006-join#001`）。**设计器实时校验请用 `diagnostics`，不要用 `'throw'`**
   * —— 抛异常只能报第一个错，诊断列表能一次列出全部。见 `known-gaps.md` §0.2。
   */
  errorMode?: 'null' | 'throw' | undefined;
}

/**
 * 便捷 API：解析一份 `.dmn`，按 id / 变量名 / 元素名求值指定决策。
 *
 * @throws {DmnXmlError | DmnModelError | DecisionError}
 */
export function decide(
  xml: string,
  decisionId: string,
  input: Record<string, unknown> = {},
  opts: DecideOptions = {},
): DecisionResult {
  const { definitions, diagnostics } = readDmn(xml);
  const opts2: { index?: ReturnType<typeof indexModel>; errorMode?: 'null' | 'throw' } = {};
  if (opts.index) opts2.index = opts.index;
  if (opts.errorMode) opts2.errorMode = opts.errorMode;
  const result = evaluateDecision(definitions, decisionId, input, opts2);
  return { ...result, diagnostics: [...diagnostics, ...result.diagnostics] };
}

/**
 * 便捷 API：求值模型里的**唯一**决策（TCK 的单决策模型适用）。
 * 决策数不等于 1 时必须显式指定入口。
 */
export function decideOnly(xml: string, input: Record<string, unknown> = {}): DecisionResult {
  const { definitions } = readDmn(xml);
  const index = indexModel(definitions);
  if (index.decisions.length !== 1) {
    throw new DecisionError({
      code: 'DMN_EVAL_NO_DECISION',
      message: '模型里的决策数不等于 1，无法推断入口',
      details: { count: index.decisions.length, names: index.decisions.map(resultName) },
      hint: '改用 decide(xml, decisionId, input) 显式指定入口',
    });
  }
  const d = index.decisions[0];
  if (!d) throw new DecisionError({ code: 'DMN_EVAL_NO_DECISION', message: '模型里没有决策' });
  return evaluateDecision(definitions, d.$id ?? '', input, { index });
}
