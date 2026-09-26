// DRG（Decision Requirement Graph）遍历 —— 本包的主执行骨架。
//
// 语义对照参考实现（MIT，`dmn-elements/src/definition/DefinitionExecution.js`）：
//  - 自底向上解析 requirement，结果按**变量名**绑进求值上下文；
//  - 结果 memo（按 id），环检测；
//  - BKM / DecisionService 绑成**可调用**，其作用域是封闭的（调用方的输入不泄漏进去）。
//
// 本实现是同步的（FEEL 求值是同步的），不引入 callback 形态。
import { DecisionError, DmnModelError, diag, type Diagnostic } from '../core/errors.js';
import type { DmnElement } from '../xml/reader.js';
import { isElement } from '../xml/reader.js';
import { toFeelContext } from './feel.js';
import { evaluateExpression, type EvalScope } from './expression.js';

/** 一次求值中的元素记录（NFR-M5：结果可解释） */
export interface TraceEntry {
  id?: string;
  name?: string;
  type: string;
  /** 命中的规则 id（仅决策表） */
  matchedRules?: string[];
  hitPolicy?: string;
  result?: unknown;
}

export interface DecisionResult {
  value: unknown;
  trace: TraceEntry[];
  diagnostics: Diagnostic[];
}

/** 模型索引：按 id / 元素名 / 变量名 三种键都能找到 DRG 元素 */
export interface ModelIndex {
  byId: Map<string, DmnElement>;
  byName: Map<string, DmnElement>;
  byVariable: Map<string, DmnElement>;
  /** definitions.drgElement 展开后的决策列表 */
  decisions: DmnElement[];
  inputData: DmnElement[];
  bkms: DmnElement[];
}

function walkAll(root: DmnElement, visit: (el: DmnElement) => void): void {
  visit(root);
  for (const [k, v] of Object.entries(root)) {
    if (k.startsWith('$')) continue;
    for (const item of Array.isArray(v) ? v : [v]) {
      if (isElement(item)) walkAll(item, visit);
    }
  }
}

export function indexModel(definitions: DmnElement): ModelIndex {
  const byId = new Map<string, DmnElement>();
  const byName = new Map<string, DmnElement>();
  const byVariable = new Map<string, DmnElement>();
  const decisions: DmnElement[] = [];
  const inputData: DmnElement[] = [];
  const bkms: DmnElement[] = [];

  walkAll(definitions, (el) => {
    if (typeof el.$id === 'string' && !byId.has(el.$id)) byId.set(el.$id, el);
    if (typeof el.name === 'string' && el.$type !== 'InformationItem' && !byName.has(el.name)) byName.set(el.name, el);
    const variable = el.variable;
    if (isElement(variable) && typeof variable.name === 'string' && !byVariable.has(variable.name)) {
      byVariable.set(variable.name, el);
    }
    if (el.$type === 'Decision') decisions.push(el);
    else if (el.$type === 'InputData') inputData.push(el);
    else if (el.$type === 'BusinessKnowledgeModel') bkms.push(el);
  });

  return { byId, byName, byVariable, decisions, inputData, bkms };
}

/** 元素的绑定名：优先变量名，其次元素名，最后 id */
export function resultName(el: DmnElement): string {
  const v = el.variable;
  if (isElement(v) && typeof v.name === 'string' && v.name) return v.name;
  if (typeof el.name === 'string' && el.name) return el.name;
  return typeof el.$id === 'string' ? el.$id : '';
}

/** `href="#id"` → id */
export function hrefId(href: unknown): string | null {
  if (typeof href !== 'string') return null;
  return href.startsWith('#') ? href.slice(1) : href;
}

interface Run {
  index: ModelIndex;
  results: Map<string, unknown>;
  visiting: Set<string>;
  trace: TraceEntry[];
  diagnostics: Diagnostic[];
  /** 调用方提供的输入数据（按 inputData 的绑定名） */
  input: Record<string, unknown>;
  /** 默认表达式语言（definitions 的 expressionLanguage） */
  expressionLanguage?: string | undefined;
}

/**
 * 求值一个决策（或决策服务）。
 * @param id 决策 id / 变量名 / 元素名 均可
 */
export function evaluateDecision(
  definitions: DmnElement,
  id: string,
  input: Record<string, unknown>,
  opts: { index?: ModelIndex } = {},
): DecisionResult {
  const index = opts.index ?? indexModel(definitions);
  const target = index.byId.get(id) ?? index.byVariable.get(id) ?? index.byName.get(id);
  if (!target) {
    throw new DecisionError({
      code: 'DMN_EVAL_NO_DECISION',
      message: '模型中找不到该决策',
      details: { id, known: [...index.byId.keys()].slice(0, 20) },
      hint: '传入 decision 的 id、variable.name 或 name',
    });
  }

  const el = typeof definitions.expressionLanguage === 'string' ? definitions.expressionLanguage : undefined;
  const run: Run = {
    index,
    results: new Map(),
    visiting: new Set(),
    trace: [],
    diagnostics: [],
    input: { ...input },
    ...(el === undefined ? {} : { expressionLanguage: el }),
  };

  const value = runDecision(target, { ...run.input }, run, definitions);
  return { value, trace: run.trace, diagnostics: run.diagnostics };
}

/** 求值全部决策（不指定入口时：所有没有出边依赖的决策都算一遍） */
export function evaluateAll(
  definitions: DmnElement,
  input: Record<string, unknown>,
): { results: Record<string, unknown>; trace: TraceEntry[]; diagnostics: Diagnostic[] } {
  const index = indexModel(definitions);
  const results: Record<string, unknown> = {};
  const trace: TraceEntry[] = [];
  const diagnostics: Diagnostic[] = [];
  for (const d of index.decisions) {
    const r = evaluateDecision(definitions, d.$id ?? '', input, { index });
    const name = resultName(d);
    if (name) results[name] = r.value;
    trace.push(...r.trace);
    diagnostics.push(...r.diagnostics);
  }
  return { results, trace, diagnostics };
}

function scopeOf(run: Run, definitions: DmnElement, vars: Record<string, unknown>): EvalScope {
  return {
    vars,
    index: run.index,
    definitions,
    diagnostics: run.diagnostics,
    ...(run.expressionLanguage === undefined ? {} : { expressionLanguage: run.expressionLanguage }),
  };
}

function runDecision(decision: DmnElement, vars: Record<string, unknown>, run: Run, definitions: DmnElement): unknown {
  const id = decision.$id ?? '';
  if (run.results.has(id)) return run.results.get(id);
  if (run.visiting.has(id)) {
    throw new DecisionError({
      code: 'DMN_EVAL_CIRCULAR',
      message: '检测到循环依赖',
      node: { id },
    });
  }
  run.visiting.add(id);

  // 决策服务不是"带表达式的元素"，它的值是**它那些 outputDecision 的值**
  if (decision.$type === 'DecisionService') {
    run.visiting.delete(id);
    return runDecisionService(decision, vars, run, definitions);
  }

  resolveRequirements(decision, vars, run, definitions);

  const entry: TraceEntry = { type: decision.$type, ...(id ? { id } : {}), ...(typeof decision.name === 'string' ? { name: decision.name } : {}) };
  const expr = decision.expression;
  const value = isElement(expr)
    ? evaluateExpression(expr, scopeOf(run, definitions, vars), entry)
    : null;

  run.visiting.delete(id);
  entry.result = value;
  run.trace.push(entry);
  run.results.set(id, value);
  return value;
}

/** 取某元素上按 `href` 引用的元素列表（`outputDecision` / `inputData` / … 都可能重复出现） */
function refsOf(el: DmnElement, key: string, run: Run): DmnElement[] {
  const v = el[key];
  const out: DmnElement[] = [];
  for (const item of Array.isArray(v) ? v : [v]) {
    const t = isElement(item) ? run.index.byId.get(hrefId(item.href) ?? '') : undefined;
    if (t) out.push(t);
  }
  return out;
}

/**
 * ★ 求值一个**决策服务**（DMN 1.5 §7.3）。
 *
 * 三件事，缺一条都不成其为 DS：
 *  ① **输入覆盖**：`inputData` / `inputDecision` 的值优先取**调用实参**，
 *     其次取宿主的 `input`（TCK 0085#003 就是直接给 `decision_003_input_1="B"`
 *     覆盖掉决策自带的 `"d3_1"`），都没有才去求值那个决策本身；
 *  ② 参数顺序 = **inputData 先、inputDecision 后**（与 XML 里的书写顺序无关 ——
 *     TCK 0085#013 `decisionService_013("A","B")` 里 `"A"` 给 inputData、`"B"` 给 inputDecision）；
 *  ③ **结果形态**：只有**一个** `outputDecision` → 直接是它的值（DMN13-163）；
 *     多个 → 以各输出决策变量名为键的 context。
 *
 * ⚠️ **不做 memo**：DS 是带参的，同一个服务用不同实参调用必须得到不同结果，
 *    按 id 缓存会把第二次调用钉死在第一次的值上。
 */
function runDecisionService(
  ds: DmnElement,
  vars: Record<string, unknown>,
  run: Run,
  definitions: DmnElement,
  args?: readonly unknown[],
): unknown {
  const local: Record<string, unknown> = { ...vars };

  const inputs = [...refsOf(ds, 'inputData', run), ...refsOf(ds, 'inputDecision', run)];
  for (const [i, el] of inputs.entries()) {
    const name = resultName(el);
    if (!name) continue;
    if (args && i < args.length) {
      local[name] = args[i];
      continue;
    }
    if (name in run.input) {
      local[name] = run.input[name];
      continue;
    }
    if (el.$type === 'InputData') {
      run.diagnostics.push(diag('DMN_DIAG_MISSING_INPUT', `输入数据未提供值：${name}`, { node: { id: el.$id ?? '' } }));
      continue;
    }
    local[name] = runDecision(el, local, run, definitions);
  }

  // 被封装的决策先求一遍（它们不进结果，但要让 outputDecision 的 requirement 能拿到 local 作用域）
  for (const el of refsOf(ds, 'encapsulatedDecision', run)) {
    const name = resultName(el);
    if (name && !(name in local)) local[name] = runDecision(el, local, run, definitions);
  }

  const outs = refsOf(ds, 'outputDecision', run);
  const values = outs.map((o) => runDecision(o, local, run, definitions));
  if (outs.length === 1) return values[0] ?? null;

  const ctx: Record<string, unknown> = {};
  for (const [i, o] of outs.entries()) {
    const name = resultName(o);
    if (name) ctx[name] = values[i] ?? null;
  }
  return toFeelContext(ctx);
}

/** 解析 informationRequirement / knowledgeRequirement，把结果绑进 `vars` */
function resolveRequirements(el: DmnElement, vars: Record<string, unknown>, run: Run, definitions: DmnElement): void {
  const reqs: DmnElement[] = [];
  for (const k of ['informationRequirement', 'knowledgeRequirement']) {
    const v = el[k];
    if (Array.isArray(v)) for (const r of v) if (isElement(r)) reqs.push(r);
    else if (isElement(v)) reqs.push(v);
  }

  for (const req of reqs) {
    const ref = req.requiredDecision ?? req.requiredInput ?? req.requiredKnowledge;
    const target = isElement(ref) ? run.index.byId.get(hrefId(ref.href) ?? '') : undefined;
    if (!target) {
      throw new DmnModelError({
        code: 'DMN_MODEL_MISSING_REFERENCE',
        message: 'requirement 指向的目标在模型中不存在',
        node: { id: el.$id ?? '', path: `${el.$type}.${req.$type}` },
        details: { href: isElement(ref) ? ref.href : null },
      });
    }

    if (target.$type === 'Decision') {
      /*
       * ★ 上层**已经给了值**就不再求值：
       *   ① 决策服务的 `inputDecision` 已被实参/宿主输入钉死（TCK 0085#003 给
       *      `decision_003_input_1="B"`，覆盖决策自带的 `"d3_1"`）；
       *   ② 调用方显式传入同名输入时，用户的意图就是"用我这个"。
       *   不判这一条，被覆盖的输入决策会被重新求值，DS 的入参等于没传。
       */
      const dn = resultName(target);
      if (!(dn in vars)) vars[dn] = runDecision(target, vars, run, definitions);
      continue;
    }
    if (target.$type === 'InputData') {
      const name = resultName(target);
      // ★ 缺席的输入**不写进作用域** —— 否则会遮蔽 FEEL 环境里的同名变量
      if (name in run.input) vars[name] = run.input[name];
      else if (!(name in vars)) {
        run.diagnostics.push(
          diag('DMN_DIAG_MISSING_INPUT', `输入数据未提供值：${name}`, { node: { id: target.$id ?? '' } }),
        );
      }
      continue;
    }
    if (target.$type === 'BusinessKnowledgeModel') {
      vars[resultName(target)] = makeInvocable(target, run, definitions);
      continue;
    }
    /*
     * ★ 决策服务绑成**可调用**：`ds(a, b)` 的实参即它的 `inputData` + `inputDecision`。
     * 它同时也是一个可被引用的值（无参调用时取宿主输入 / 决策自身的值）。
     */
    if (target.$type === 'DecisionService') {
      const name = resultName(target);
      const fn = (...args: unknown[]): unknown =>
        runDecisionService(target, vars, run, definitions, args);
      const params = [
        ...refsOf(target, 'inputData', run),
        ...refsOf(target, 'inputDecision', run),
      ].map(resultName);
      Object.defineProperty(fn, '$args', { value: params, enumerable: false });
      vars[name] = fn;
      continue;
    }
    throw new DecisionError({
      code: 'DMN_EVAL_UNSUPPORTED_EXPRESSION',
      message: '暂不支持的 requirement 目标类型',
      node: { id: el.$id ?? '' },
      details: { type: target.$type },
    });
  }
}

/**
 * BKM → FEEL 可调用函数。作用域封闭：BKM 自己的 requirement 在这里解析一次，
 * 调用方传入的 vars **不泄漏**进去（只把形参绑进去）。
 */
function makeInvocable(bkm: DmnElement, run: Run, definitions: DmnElement): unknown {
  const id = bkm.$id ?? '';
  const cached = run.results.get(id);
  if (cached !== undefined) return cached;

  const closed: Record<string, unknown> = {};
  resolveRequirements(bkm, closed, run, definitions);
  const expr = bkm.encapsulatedLogic;
  const params = Array.isArray(bkm.variable)
    ? []
    : (isElement(bkm.encapsulatedLogic) && Array.isArray(bkm.encapsulatedLogic.formalParameter)
        ? bkm.encapsulatedLogic.formalParameter.filter(isElement).map((p) => (typeof p.name === 'string' ? p.name : ''))
        : []);

  const fn = (...args: unknown[]): unknown => {
    const local: Record<string, unknown> = { ...closed };
    for (const [i, name] of params.entries()) {
      if (name) local[name] = args[i];
    }
    if (!isElement(expr)) return null;
    return evaluateExpression(expr, scopeOf(run, definitions, local));
  };
  // feelin/feel 靠 `$args` 读形参数与名字（命名实参映射、元数校验）
  Object.defineProperty(fn, '$args', { value: params, enumerable: false });
  run.results.set(id, fn);
  return fn;
}
