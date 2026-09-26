// 决策表求值（命中策略 + 聚合）。
//
// 语义对照（规范 Table 41 / 参考实现 `dmn-elements/src/decisionLogic/DecisionTable.js`）：
//  - 输入条目是 **unary tests**，被验值绑在 `?` 上；`-` 或空 = 无关（恒命中）；
//  - 单输出列 → 裸值；多输出列 → 按输出名（缺省用 id）组成 context；
//  - **无命中且有 defaultOutputEntry** → 不论命中策略，都返回默认值；
//  - 命中策略违反（UNIQUE 多命中、ANY 结果不一致）→ **抛**（NFR-M4，不静默取第一个）。
import { DecisionError, diag, type Diagnostic } from '../core/errors.js';
import { isElement, type DmnElement } from '../xml/reader.js';
import { coerceTypeRef, evalExpression, evalUnaryTests } from './feel.js';
import { evaluateExpression, type EvalScope } from './expression.js';

export interface DecisionTableOutcome {
  value: unknown;
  /** 命中的规则 id（NFR-M5 / AC-M7） */
  matchedRules: string[];
  hitPolicy: string;
  aggregation?: string;
}

export function hitPolicyOf(table: DmnElement): string {
  const hp = table.hitPolicy;
  return typeof hp === 'string' && hp ? hp : 'UNIQUE';
}

/** 输出列名：优先 name，其次 id */
function outputName(output: DmnElement): string {
  if (typeof output.name === 'string' && output.name) return output.name;
  return typeof output.$id === 'string' ? output.$id : '';
}

function entryText(el: unknown): string {
  if (!isElement(el)) return '';
  const t = el.text;
  return typeof t === 'string' ? t.trim() : '';
}

export function evaluateDecisionTable(
  table: DmnElement,
  scope: EvalScope,
  trace?: { matchedRules?: string[]; hitPolicy?: string },
): DecisionTableOutcome {
  const inputs = Array.isArray(table.input) ? table.input.filter(isElement) : [];
  const outputs = Array.isArray(table.output) ? table.output.filter(isElement) : [];
  const rules = Array.isArray(table.rule) ? table.rule.filter(isElement) : [];
  const hitPolicy = hitPolicyOf(table);
  const aggregation = typeof table.aggregation === 'string' ? table.aggregation : undefined;

  if (outputs.length === 0) {
    throw new DecisionError({
      code: 'DMN_EVAL_UNSUPPORTED_EXPRESSION',
      message: '决策表没有输出列',
      node: { id: table.$id ?? '' },
    });
  }

  // --- 输入值 ---
  const inputValues = inputs.map((clause) => {
    const ie = clause.inputExpression;
    const text = isElement(ie) ? entryText(ie) : '';
    if (!text) return null;
    const raw = evalExpression(text, scope.vars, { id: clause.$id ?? '', path: 'inputClause.inputExpression' }, scope.index.typeSpecs);
    scope.diagnostics.push(...raw.warnings);
    return coerceTypeRef(raw.value, isElement(ie) ? ie.typeRef : undefined, { id: clause.$id ?? '' });
  });

  // --- 匹配 ---
  const matched = rules.filter((rule) => matchesRule(rule, inputValues, scope));

  if (trace) {
    trace.hitPolicy = hitPolicy;
    trace.matchedRules = matched.map((r) => r.$id ?? '');
  }

  const value = resolveHitPolicy(table, matched, outputs, hitPolicy, aggregation, scope);
  return {
    value,
    matchedRules: matched.map((r) => r.$id ?? ''),
    hitPolicy,
    ...(aggregation === undefined ? {} : { aggregation }),
  };
}

function matchesRule(rule: DmnElement, inputValues: unknown[], scope: EvalScope): boolean {
  const entries = Array.isArray(rule.inputEntry) ? rule.inputEntry : [];
  for (const [idx, entry] of entries.entries()) {
    const text = entryText(entry);
    if (!text || text === '-') continue; // 无关条目：恒命中
    const r = evalUnaryTests(text, inputValues[idx], scope.vars, { id: rule.$id ?? '', path: `rule.inputEntry[${idx}]` }, scope.index.typeSpecs);
    scope.diagnostics.push(...r.warnings);
    if (r.value !== true) return false;
  }
  return true;
}

function ruleOutput(rule: DmnElement, outputs: DmnElement[], scope: EvalScope): unknown {
  const entries = Array.isArray(rule.outputEntry) ? rule.outputEntry : [];
  if (outputs.length < 2) return entryValue(entries[0], outputs[0]?.typeRef, scope);
  const out: Record<string, unknown> = {};
  for (const [idx, output] of outputs.entries()) {
    out[outputName(output)] = entryValue(entries[idx], output.typeRef, scope);
  }
  return out;
}

function entryValue(entry: unknown, typeRef: unknown, scope: EvalScope): unknown {
  const text = entryText(entry);
  if (!text) return null;
  const r = evalExpression(text, scope.vars, { path: 'outputEntry' }, scope.index.typeSpecs);
  scope.diagnostics.push(...r.warnings);
  return coerceTypeRef(r.value, typeRef);
}

function defaultOutput(outputs: DmnElement[], scope: EvalScope): unknown {
  if (outputs.length < 2) {
    const o = outputs[0];
    return o ? entryValue(o.defaultOutputEntry, o.typeRef, scope) : null;
  }
  const out: Record<string, unknown> = {};
  for (const output of outputs) {
    out[outputName(output)] = isElement(output.defaultOutputEntry)
      ? entryValue(output.defaultOutputEntry, output.typeRef, scope)
      : null;
  }
  return out;
}

function hitPolicyError(table: DmnElement, hitPolicy: string, matched: DmnElement[], details: Record<string, unknown> = {}): DecisionError {
  return new DecisionError({
    code: 'DMN_EVAL_HIT_POLICY',
    message: `命中策略 ${hitPolicy} 被违反`,
    node: { id: table.$id ?? '' },
    details: { hitPolicy, matchedRules: matched.map((r) => r.$id ?? ''), ...details },
  });
}

function resolveHitPolicy(
  table: DmnElement,
  matched: DmnElement[],
  outputs: DmnElement[],
  hitPolicy: string,
  aggregation: string | undefined,
  scope: EvalScope,
): unknown {
  // 无命中且任一输出列声明了默认值 —— 与命中策略无关（规范如此）
  if (matched.length === 0 && outputs.some((o) => isElement(o.defaultOutputEntry))) {
    return defaultOutput(outputs, scope);
  }

  switch (hitPolicy) {
    case 'UNIQUE': {
      if (matched.length > 1) throw hitPolicyError(table, hitPolicy, matched);
      return matched.length ? ruleOutput(matched[0] as DmnElement, outputs, scope) : null;
    }
    case 'ANY': {
      if (!matched.length) return null;
      const values = matched.map((r) => ruleOutput(r, outputs, scope));
      const first = JSON.stringify(values[0]);
      if (!values.every((v) => JSON.stringify(v) === first)) throw hitPolicyError(table, hitPolicy, matched);
      return values[0];
    }
    case 'FIRST':
      return matched.length ? ruleOutput(matched[0] as DmnElement, outputs, scope) : null;
    case 'PRIORITY':
      return matched.length ? (sortByPriority(table, matched, outputs, hitPolicy, scope)[0] ?? null) : null;
    case 'RULE ORDER':
      return matched.map((r) => ruleOutput(r, outputs, scope));
    case 'OUTPUT ORDER':
      return sortByPriority(table, matched, outputs, hitPolicy, scope);
    case 'COLLECT':
      return collect(table, matched, outputs, aggregation, scope);
    default:
      throw new DecisionError({
        code: 'DMN_EVAL_HIT_POLICY',
        message: '不支持的命中策略',
        node: { id: table.$id ?? '' },
        details: { hitPolicy, supported: ['UNIQUE', 'FIRST', 'PRIORITY', 'ANY', 'COLLECT', 'RULE ORDER', 'OUTPUT ORDER'] },
      });
  }
}

/** 按输出列的 outputValues 排序（优先级高者在前） */
function sortByPriority(
  table: DmnElement,
  matched: DmnElement[],
  outputs: DmnElement[],
  hitPolicy: string,
  scope: EvalScope,
): unknown[] {
  const priorities = outputs.map((output) => {
    const text = entryText(output.outputValues);
    if (!text) return null;
    const r = evalExpression(`[${text}]`, scope.vars, { path: 'outputClause.outputValues' }, scope.index.typeSpecs);
    scope.diagnostics.push(...r.warnings);
    return Array.isArray(r.value) ? r.value : null;
  });
  if (!priorities.some(Boolean)) {
    throw new DecisionError({
      code: 'DMN_EVAL_HIT_POLICY',
      message: `命中策略 ${hitPolicy} 要求至少一个输出列声明 outputValues`,
      node: { id: table.$id ?? '' },
      details: { hitPolicy },
    });
  }
  const rankOf = (values: readonly unknown[] | null, v: unknown): number => {
    if (!values) return 0;
    const i = values.indexOf(v);
    return i === -1 ? values.length : i;
  };
  const ranked = matched.map((rule) => {
    const value = ruleOutput(rule, outputs, scope);
    const vector =
      outputs.length < 2
        ? [rankOf(priorities[0] ?? null, value)]
        : outputs.map((output, idx) => (priorities[idx] ? rankOf(priorities[idx] ?? null, (value as Record<string, unknown>)[outputName(output)]) : 0));
    return { value, vector };
  });
  ranked.sort((a, b) => {
    for (let i = 0; i < a.vector.length; i += 1) {
      const x = a.vector[i] ?? 0;
      const y = b.vector[i] ?? 0;
      if (x !== y) return x - y;
    }
    return 0;
  });
  return ranked.map((r) => r.value);
}

function collect(
  table: DmnElement,
  matched: DmnElement[],
  outputs: DmnElement[],
  aggregation: string | undefined,
  scope: EvalScope,
): unknown {
  const values = matched.map((r) => ruleOutput(r, outputs, scope));
  if (!aggregation) return values;
  if (outputs.length > 1) {
    throw new DecisionError({
      code: 'DMN_EVAL_HIT_POLICY',
      message: 'COLLECT 聚合要求单输出列',
      node: { id: table.$id ?? '' },
      details: { aggregation },
    });
  }
  switch (aggregation) {
    case 'COUNT':
      return values.length;
    case 'SUM':
    case 'MIN':
    case 'MAX': {
      if (values.some((v) => typeof v !== 'number')) {
        throw new DecisionError({
          code: 'DMN_EVAL_HIT_POLICY',
          message: `COLLECT ${aggregation} 聚合要求数值输出`,
          node: { id: table.$id ?? '' },
          details: { aggregation },
        });
      }
      if (!values.length) return null;
      const nums = values as number[];
      if (aggregation === 'SUM') return nums.reduce((a, b) => a + b, 0);
      return aggregation === 'MIN' ? Math.min(...nums) : Math.max(...nums);
    }
    default:
      throw new DecisionError({
        code: 'DMN_EVAL_HIT_POLICY',
        message: '不支持的 COLLECT 聚合',
        node: { id: table.$id ?? '' },
        details: { aggregation, supported: ['SUM', 'COUNT', 'MIN', 'MAX'] },
      });
  }
}

