// DRG（Decision Requirement Graph）遍历 —— 本包的主执行骨架。
//
// 语义对照参考实现（MIT，`dmn-elements/src/definition/DefinitionExecution.js`）：
//  - 自底向上解析 requirement，结果按**变量名**绑进求值上下文；
//  - 结果 memo（按 id），环检测；
//  - BKM / DecisionService 绑成**可调用**，其作用域是封闭的（调用方的输入不泄漏进去）。
//
// 本实现是同步的（FEEL 求值是同步的），不引入 callback 形态。
import type { TypeSpec } from 'floken-feel';
import { DecisionError, DmnModelError, diag, type Diagnostic } from '../core/errors.js';
import type { DmnElement } from '../xml/reader.js';
import { isElement } from '../xml/reader.js';
import { buildTypeSpecs, coerceTypeRef, toFeelContext, toFeelFunction } from './feel.js';
import { evaluateExpression, functionParts, type EvalScope } from './expression.js';

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
  /** itemDefinition 名 → 定义（typeRef 强制要用：复合类型与集合） */
  itemDefinitions: Map<string, DmnElement>;
  /**
   * itemDefinition 名 → FEEL 类型规格（`instance of <itemDefinition 名>` 用）。
   * 由 `itemDefinitions` 派生，随索引一起建好 —— 求值时不再重算。
   */
  typeSpecs: Record<string, TypeSpec>;
  /**
   * 已解析的 `<import>`（按前缀名限定引用：`myimport.Say Hello(...)` /
   * `typeRef="myimport.tPerson"` / `a.person.name`）。**未给 `resolveImport` 时为空**。
   */
  imports: ImportBinding[];
}

/**
 * 一个 `<import>` 解析出来的绑定。
 *
 * ★ 被导入模型的元素会**并入**宿主索引（`byId` / `byName` / `itemDefinitions` …），
 *   于是 `href="<被导入命名空间>#id"` 直接就能引用到（TCK 0089 甚至写错了命名空间段，
 *   只靠 `#` 后的 id 命中）。这里额外记一份「前缀名 → 元素表」，供**限定引用**使用。
 */
export interface ImportBinding {
  /** `<import name="…">` —— 限定前缀（可含空格，如 `Model B`） */
  name: string;
  namespace: string;
  /** 被导入模型里的 DRG 元素：绑定名 → 元素 */
  elements: Map<string, DmnElement>;
}

/**
 * 建索引时的可选项。
 *
 * ★ **为什么必须有个 `resolveImport` 回调**：本库的入口是 **XML 字符串 / 已解析的
 *   definitions**，它**没有文件上下文**，无从知道"另一个模型在哪"。所以"去哪儿读"
 *   只能由调用方回答 —— TCK 运行器按 `locationURI` 读同目录文件，没有 `locationURI`
 *   时按 `namespace` 扫同目录的 `.dmn`（TCK 0086 / 0089 都是这种写法）。
 */
export interface IndexOptions {
  /**
   * 解析一个 `<import>`：返回被导入模型的 `definitions`（通常是
   * `readDmn(xml).definitions`）。返回 `null`/`undefined` 表示解析不出来 ——
   * 该导入被跳过，引用它的 href 会照旧报 `DMN_MODEL_MISSING_REFERENCE`。
   */
  resolveImport?: (imp: DmnElement) => unknown;
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

export function indexModel(definitions: DmnElement, options?: IndexOptions): ModelIndex {
  return buildIndex(definitions, options, new Map());
}

/** 递归建索引（含 `<import>` 的传递展开）；`byNamespace` 防循环导入 */
function buildIndex(definitions: DmnElement, options: IndexOptions | undefined, byNamespace: Map<string, ModelIndex>): ModelIndex {
  const byId = new Map<string, DmnElement>();
  const byName = new Map<string, DmnElement>();
  const byVariable = new Map<string, DmnElement>();
  const decisions: DmnElement[] = [];
  const inputData: DmnElement[] = [];
  const bkms: DmnElement[] = [];
  const itemDefinitions = new Map<string, DmnElement>();
  const imports: ImportBinding[] = [];

  walkAll(definitions, (el) => {
    if (typeof el.$id === 'string' && !byId.has(el.$id)) byId.set(el.$id, el);
    if (el.$type === 'ItemDefinition' && typeof el.name === 'string' && !itemDefinitions.has(el.name)) {
      itemDefinitions.set(el.name, el);
    }
    if (typeof el.name === 'string' && el.$type !== 'InformationItem' && !byName.has(el.name)) byName.set(el.name, el);
    const variable = el.variable;
    if (isElement(variable) && typeof variable.name === 'string' && !byVariable.has(variable.name)) {
      byVariable.set(variable.name, el);
    }
    if (el.$type === 'Decision') decisions.push(el);
    else if (el.$type === 'InputData') inputData.push(el);
    else if (el.$type === 'BusinessKnowledgeModel') bkms.push(el);
  });

  const ns = typeof definitions.namespace === 'string' ? definitions.namespace : '';
  if (ns) byNamespace.set(ns, { byId, byName, byVariable, decisions, inputData, bkms, itemDefinitions, typeSpecs: {}, imports });

  /*
   * ★ `<import>` 的展开（DMN 1.5 §7.2）。
   *
   * 三件事，缺一件 TCK 那 7 条都过不去：
   *  ① **并入宿主索引**：`byId` 合进来，`href="<被导入 ns>#id"` 才命中
   *     （TCK 1160 的 `requiredInput href="…A#_B498…"`、0089 的 `…#_96df…`）；
   *  ② **限定名**：`itemDefinitions` 加 `前缀.类型名`（0086 的 `typeRef="myimport.tPerson"`）、
   *     `byName` 加 `前缀.元素名`；
   *  ③ **前缀绑定**：`前缀` 绑成一个 context，成员是该模型的 DRG 元素值
   *     （0086 的 `myimport.Say Hello(...)`、0089 的 `Model B.Evaluating Say Hello`、
   *      1160 的 `a.person.name`）。
   *
   * ⚠️ 传递导入（0089：Model_B 自己还导入 modelA）：被导入模型的 **import 绑定也一并
   *   上浮**，于是求 `Model B` 的决策时 `modelA` 也在作用域里。严格来说规范不保证跨层
   *   可见，但 TCK 的期望值依赖于此（`"Evaluating Say Hello to: "+modelA.Greet the Person`）。
   */
  for (const imp of asElements(definitions.import)) {
    const name = typeof imp.name === 'string' ? imp.name.trim() : '';
    const namespace = typeof imp.namespace === 'string' ? imp.namespace : '';
    const resolved = options?.resolveImport?.(imp);
    if (!isElement(resolved)) continue;

    const sub =
      namespace && byNamespace.has(namespace)
        ? byNamespace.get(namespace)!
        : buildIndex(resolved, options, byNamespace);

    for (const [id, el] of sub.byId) if (!byId.has(id)) byId.set(id, el);
    for (const [k, el] of sub.byName) {
      if (!byName.has(k)) byName.set(k, el);
      /*
       * ★ `<import name="">`（**空前缀**，DMN16-50 的"多导入不命名"写法，
       *   TCK 1160 的 02-B / 02-C 就是）：只并入、**不加限定名** ——
       *   `多了个 "."` 前缀的键没意义，而且会挤掉真正的前缀绑定。
       */
      if (name && !byName.has(`${name}.${k}`)) byName.set(`${name}.${k}`, el);
    }
    for (const [k, el] of sub.byVariable) {
      if (!byVariable.has(k)) byVariable.set(k, el);
      if (name && !byVariable.has(`${name}.${k}`)) byVariable.set(`${name}.${k}`, el);
    }
    for (const [k, d] of sub.itemDefinitions) {
      if (!itemDefinitions.has(k)) itemDefinitions.set(k, d);
      if (name && !itemDefinitions.has(`${name}.${k}`)) itemDefinitions.set(`${name}.${k}`, d);
    }
    for (const d of sub.decisions) if (!decisions.includes(d)) decisions.push(d);
    for (const d of sub.inputData) if (!inputData.includes(d)) inputData.push(d);
    for (const d of sub.bkms) if (!bkms.includes(d)) bkms.push(d);
    for (const b of sub.imports) if (!imports.some((x) => x.name === b.name)) imports.push(b);

    // 空前缀不建绑定（没有前缀可用，元素已按本名并入，直接引用即可）
    if (!name) continue;
    const elements = new Map<string, DmnElement>();
    walkAll(resolved, (el) => {
      if (DRG_TYPES.has(el.$type ?? '')) {
        const n = resultName(el);
        if (n && !elements.has(n)) elements.set(n, el);
      }
    });
    if (!imports.some((x) => x.name === name)) imports.push({ name, namespace, elements });
  }

  return {
    byId,
    byName,
    byVariable,
    decisions,
    inputData,
    bkms,
    itemDefinitions,
    typeSpecs: buildTypeSpecs(itemDefinitions),
    imports,
  };
}

/** 可被 `<import>` 引入的 DRG 元素类型 */
const DRG_TYPES: ReadonlySet<string> = new Set([
  'Decision',
  'InputData',
  'BusinessKnowledgeModel',
  'DecisionService',
]);

/** 属性 → 元素数组（单个元素也当成长度 1） */
function asElements(v: unknown): DmnElement[] {
  const arr = Array.isArray(v) ? v : v === undefined ? [] : [v];
  return arr.filter(isElement);
}

/** 元素的绑定名：优先变量名，其次元素名，最后 id */
export function resultName(el: DmnElement): string {
  const v = el.variable;
  if (isElement(v) && typeof v.name === 'string' && v.name) return v.name;
  if (typeof el.name === 'string' && el.name) return el.name;
  return typeof el.$id === 'string' ? el.$id : '';
}

/**
 * `href="#id"` / `href="<namespace>#id"` / `href="id"` → id。
 *
 * ★ **本地限定 href**：DMN 允许用「本模型命名空间 + `#` + id」的完整形式引用本模型的
 *   元素（TCK 0091 整组就是这样写的，且它**没有** `<import>`）。只认 `#` 前缀会把
 *   `http://…/0091-local-hrefs#_decision_001` 整串当 id 用，于是引用落空 → 抛
 *   `DMN_MODEL_MISSING_REFERENCE`。
 *   跨命名空间的那一段（真正指向 `<import>` 的）同样先取出 `#` 后的 id ——
 *   能否找到取决于导入模型是否已并入索引，与本函数无关。
 */
export function hrefId(href: unknown): string | null {
  if (typeof href !== 'string') return null;
  const i = href.indexOf('#');
  if (i < 0) return href;
  return href.slice(i + 1);
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
  /**
   * ★ >0 时**绕过** `results` 缓存（既不读也不写）。
   * 决策服务**带实参**调用时，它的输出决策必须按当次实参重算 ——
   * 详见 `runDecisionService` 里的说明（TCK 0092）。
   */
  fresh: number;
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
    fresh: 0,
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
    /*
     * ★ `<import>` 的前缀在这里并入（见 `importScopes` 的说明）。
     *   放在**求表达式这一步**而不是 `resolveRequirements` 里，是为了按当时的作用域
     *   重新算 —— 被导入的元素可能此刻才刚求值完。
     */
    vars: importScopes(vars, run, definitions),
    index: run.index,
    definitions,
    diagnostics: run.diagnostics,
    ...(run.expressionLanguage === undefined ? {} : { expressionLanguage: run.expressionLanguage }),
  };
}

function runDecision(decision: DmnElement, vars: Record<string, unknown>, run: Run, definitions: DmnElement): unknown {
  const id = decision.$id ?? '';
  if (run.fresh === 0 && run.results.has(id)) return run.results.get(id);
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
    const raw = runDecisionService(decision, vars, run, definitions);
    /*
     * ★ 决策服务的**值**也要按 `variable.typeRef` 强制一次 —— 与决策/BKM 同一条规则。
     * 只强制输出决策自己那层是不够的：TCK 1157 的 `To Singleton List DS` 声明
     * `functionReturningDateList`，输出决策的值是 `date("2000-01-02")` → 期望 `[…]`；
     * `From Singleton List DS` 声明 `functionReturningDate`，值却是单例列表 → 期望标量。
     */
    const declared = isElement(decision.variable) ? decision.variable.typeRef : undefined;
    return typeof declared === 'string' && declared !== ''
      ? coerceTypeRef(raw, declared, { id }, run.index)
      : raw;
  }

  resolveRequirements(decision, vars, run, definitions);

  /*
   * ★ **BKM 没有 `expression`**，只有 `encapsulatedLogic`（= `tFunctionDefinition`）。
   *
   * ① **无形参**的 BKM，它的**值**就是 body 的值 —— 不是一个函数。
   *    TCK 1157 的 `To Singleton List BKM`（body `1`，声明
   *    `functionReturningNumberList`）期望 `[1]`：body 的值再按
   *    `functionItem.outputTypeRef` 强制一次。
   *    不这么处理的话 `expr` 是 undefined → raw 恒为 null，三条 BKM 全塌。
   * ② 有形参的 BKM 的值仍是**函数**（`makeInvocable`），下面不做输出强制。
   */
  if (decision.$type === 'BusinessKnowledgeModel') {
    const f = makeInvocable(decision, run, definitions) as unknown as {
      call: (args: unknown[]) => unknown;
      params?: readonly string[];
    };
    const declared = isElement(decision.variable) ? decision.variable.typeRef : undefined;
    const args = (f as unknown as { $args?: readonly string[] }).$args ?? [];
    const raw = args.length === 0 ? f.call([]) : f;
    const value =
      typeof declared === 'string' && declared !== ''
        ? coerceTypeRef(raw, declared, { id }, run.index)
        : raw;
    run.visiting.delete(id);
    const bkmEntry: TraceEntry = {
      type: decision.$type,
      ...(id ? { id } : {}),
      ...(typeof decision.name === 'string' ? { name: decision.name } : {}),
      result: value,
    };
    run.trace.push(bkmEntry);
    if (run.fresh === 0) run.results.set(id, value);
    return value;
  }

  const entry: TraceEntry = { type: decision.$type, ...(id ? { id } : {}), ...(typeof decision.name === 'string' ? { name: decision.name } : {}) };
  const expr = decision.expression;
  const raw = isElement(expr)
    ? evaluateExpression(expr, scopeOf(run, definitions, vars), entry)
    : null;
  /*
   * ★ **决策层**也要按 `variable.typeRef` 强制一次。
   * 只强制表达式自带的 `typeRef` 是不够的 —— 那个属性是**可选**的，
   * 而 TCK 0082 全是只在 `<variable typeRef="…"/>` 上声明的：
   * `decision_007` 值 `["foo"]` 声明 string → `"foo"`（单例解包）、
   * `decision_001` 值 `2` 声明 string → `null`（number→string 不做）、
   * `decision_005` 值 `{name:"foo"}` 声明 tNameAndAge → `null`（缺 age 组件）。
   */
  const declared = isElement(decision.variable) ? decision.variable.typeRef : undefined;
  const value =
    typeof declared === 'string' && declared !== ''
      ? coerceTypeRef(raw, declared, { id }, run.index)
      : raw;

  run.visiting.delete(id);
  entry.result = value;
  run.trace.push(entry);
  if (run.fresh === 0) run.results.set(id, value);
  return value;
}

/** 元素声明的类型（`variable.typeRef`）；未声明 → undefined */
function declaredTypeRef(el: DmnElement): string | undefined {
  const v = el.variable;
  const t = isElement(v) ? v.typeRef : undefined;
  return typeof t === 'string' && t !== '' ? t : undefined;
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
 * 把实参绑到形参上，并**按形参的 `typeRef` 强制**。
 * @returns 绑定表；任一形参强制失败 → `null`（调用不适用）
 */
function bindParams(
  params: readonly string[],
  types: readonly (string | undefined)[],
  args: readonly unknown[],
  index: ModelIndex,
): Record<string, unknown> | null {
  const out: Record<string, unknown> = {};
  for (const [i, name] of params.entries()) {
    const raw = i < args.length ? args[i] : null;
    const t = types[i];
    const v = t ? coerceTypeRef(raw, t, undefined, index) : raw;
    /*
     * ★ 声明了类型却强制不出来 → 不适用。判据必须是「**传入的不是 null，却强制成 null**」，
     *   不能写成 `v === undefined` —— `coerceTypeRef` 失败时返回的是 `null` 不是 `undefined`
     *   （`coerceComposite` 缺组件/缺键一律 `return null`），于是这条永远不触发：
     *   TCK 0082 的 `bkm_001({name: "foo"})`（形参 `tNameAndAge` 缺 age）
     *   就一路算成了 `null != null` 的 `false`，而期望是整个调用不适用 → null。
     *   反过来，实参**本来就是** null 时不得拒绝：null 是一等合法值。
     */
    if (t && raw !== null && v === null) return null;
    if (name) out[name] = v === undefined ? null : v;
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

  /*
   * ★ **形参个数必须恰好相等**（DMN 1.5 §7.3：`inputData` + `inputDecision` 就是决策服务的形参表）。
   *   - 多给（`decisionService_005("bar")`，DS 无形参）→ 调用不适用 → `null`（TCK 0085#005）；
   *   - 少给（`decisionService_008()`，DS 要一个）→ 同样 `null`（TCK 0085#008）。
   *   不是"忽略多余的 / 自己去算缺失的" —— 那两种宽容处理会把本该失败的输入
   *   悄悄算出来，错误反而被掩盖。
   */
  if (args && args.length !== inputs.length) return null;

  for (const [i, el] of inputs.entries()) {
    const name = resultName(el);
    if (!name) continue;
    const declared = declaredTypeRef(el);
    if (args) {
      const raw = args[i];
      const v = declared ? coerceTypeRef(raw, declared, { id: el.$id ?? '' }, run.index) : raw;
      /*
       * ★ 实参**类型不符** → 整个调用不适用（TCK 0085#007：给 string 形参传 `123`）。
       *   注意与"实参本来就是 null"区分：null 是一等合法值，不做拦截。
       */
      if (declared && raw !== null && v === null) return null;
      local[name] = v === undefined ? null : v;
      continue;
    }
    /*
     * ★ 决策服务**作为可调用对象**求值时，入参只来自**调用上下文**（实参 / 宿主输入）。
     *   缺口**不回退到"自己算那个决策"** —— `inputDecision` 在这里是**形参**，
     *   没给就是没给：TCK 0085#002_a 明确期望 `null`（"requires decision_002_input
     *   but we're not providing it"），而回退求值会算出它自带的 `"bar"` → `"foo bar"`。
     */
    if (name in local) {
      local[name] = declared ? coerceTypeRef(local[name], declared, { id: el.$id ?? '' }, run.index) : local[name];
      continue;
    }
    if (name in run.input) {
      local[name] = declared ? coerceTypeRef(run.input[name], declared, { id: el.$id ?? '' }, run.index) : run.input[name];
      continue;
    }
    local[name] = null;
  }

  /*
   * ★ **带实参调用必须绕过结果缓存**（TCK 0092 decision_013_1）。
   *
   *   `bkm_013_1(decisionService_013_1, decisionService_013_1)` 的 body 是
   *   `fn1(5)*fn2(10)` —— 同一个决策服务被带**不同实参**调了两次。
   *   而 `run.results` 是按**元素 id** 记忆的：不绕过的话 `fn2(10)` 读到的是
   *   `fn1(5)` 那次缓存下来的 50，于是得 2500 而不是 5000。
   *
   *   只有带实参（`args !== undefined`）才绕过：决策服务**当值引用**（无参）时
   *   仍是一次求值，照旧走缓存。
   */
  run.fresh += args === undefined ? 0 : 1;
  try {
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
  } finally {
    run.fresh -= args === undefined ? 0 : 1;
  }
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
      /*
       * ★ **上层已经给了值就不覆盖**。
       *   决策服务的 `inputData` 由**调用实参**钉死（TCK 0085#013：
       *   `decisionService_013("A","B")` 里 `"A"` 给 `inputData_013_1`），
       *   而全局 `run.input` 里同名键是 `"C"` —— 用全局值回写会把实参冲掉。
       * 缺席的输入**不写进作用域** —— 否则会遮蔽 FEEL 环境里的同名变量。
       */
      if (name in vars) continue;
      /*
       * ★ **输入数据也要按 `variable.typeRef` 强制**（DMN 1.5 §10.3.2 的隐式转换）：
       *   TCK 0082 `decisionService_002` 给 string 形参传 `10`，期望输入被强制成 null。
       *   只在决策表/输出的那一侧做强制是不够的 —— 输入进作用域的这一步就得做。
       */
      if (name in run.input) {
        const declared = declaredTypeRef(target);
        vars[name] = declared
          ? coerceTypeRef(run.input[name], declared, { id: target.$id ?? '' }, run.index)
          : run.input[name];
      } else
        run.diagnostics.push(
          diag('DMN_DIAG_MISSING_INPUT', `输入数据未提供值：${name}`, { node: { id: target.$id ?? '' } }),
        );
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
      /*
       * ★ 形参名要挂到**函数值**上（`FeelFunction.params`），不只挂 `$args`：
       *   FEEL 的命名调用（`decisionService_012(decision_012_3: "C", …)`）在求值器里
       *   按形参名对位，而它只认函数值自带的那份（TCK 0085#009/#012）。
       */
      const f = toFeelFunction(name, (...args) => fn(...args) as never, params);
      Object.defineProperty(f, '$args', { value: params, enumerable: false });
      vars[name] = f;
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
 * 把每个 `<import>` 的前缀绑成一个 **context** 后并入作用域，供限定引用使用
 * （`myimport.Say Hello(...)`、`Model B.Evaluating Say Hello`、`a.person.name`）。
 *
 * ★ **DMN16-50：只绑一次就够了** —— 被导入的输入数据与"直接用名字绑进来的"是
 *   同一个东西，`a.person` 与 `person` 必须拿到**同一个值**（TCK 1160 test-01 的
 *   用例描述就是这个 issue）。实现上：名字已在作用域里就**直接复用那个值**，不另算。
 *
 * ⚠️ **必须返回新对象，不能往调用方的 `vars` 上写**：嵌套决策与被调方**共用同一个
 *   vars 对象**，先求值的那个（1160 的 DecisionB 是 DecisionC 的 requiredDecision）
 *   会把**尚未算出**的 `b.DecisionB` 绑成空 context 写进去；等外层决策再想绑时又被
 *   "已存在"挡住 —— 于是 `b.DecisionB` 永远找不到，DecisionC 恒为 null。
 *   每次按当前作用域重新算、谁求表达式谁用，就没有这个先后问题。
 */
function importScopes(vars: Record<string, unknown>, run: Run, definitions: DmnElement): Record<string, unknown> {
  if (run.index.imports.length === 0) return vars;
  const extra: Record<string, unknown> = {};
  for (const b of run.index.imports) {
    if (b.name === '' || b.name in vars) continue;
    const map: Record<string, unknown> = {};
    for (const [ename, target] of b.elements) {
      if (ename in vars) {
        map[ename] = vars[ename];
        continue;
      }
      const tid = target.$id ?? '';
      // 已算过 → 直接用缓存，不必重算
      if (tid && run.results.has(tid)) {
        map[ename] = run.results.get(tid);
        continue;
      }
      // 正在求值中 → 跳过（否则撞 DMN_EVAL_CIRCULAR）；它的值由**外层**那次绑定补上
      if (tid && run.visiting.has(tid)) continue;
      if (target.$type === 'InputData') {
        map[ename] = ename in run.input ? run.input[ename] : null;
        continue;
      }
      map[ename] = runDecision(target, { ...vars, ...map, ...extra }, run, definitions);
    }
    extra[b.name] = toFeelContext(map);
  }
  return Object.keys(extra).length === 0 ? vars : { ...vars, ...extra };
}

/**
 * BKM → FEEL 可调用函数。作用域封闭：BKM 自己的 requirement 在这里解析一次，
 * 调用方传入的 vars **不泄漏**进去（只把形参绑进去）。
 */
function makeInvocable(bkm: DmnElement, run: Run, definitions: DmnElement): unknown {
  const id = bkm.$id ?? '';
  const cached = run.results.get(`${id}#fn`);
  if (cached !== undefined) return cached;

  const closed: Record<string, unknown> = {};
  resolveRequirements(bkm, closed, run, definitions);
  const encap = bkm.encapsulatedLogic;
  /*
   * ★ BKM 的 `encapsulatedLogic` **就是** `tFunctionDefinition`（DMN 1.5 XSD：
   * `<xsd:element name="encapsulatedLogic" type="tFunctionDefinition"/>`）。
   * 因此 `bkm(x)` = **把实参绑到 formalParameter 上求它的 body** ——
   * 而不是"求值一次拿到函数就完事"（那样 `gtTen(i.price)` 得到的仍是个函数，
   * 于是在 `= true` 处报 "got function and boolean"，TCK 0016/0092 一片挂在这一点上）。
   */
  const fd = isElement(encap) && encap.$type === 'FunctionDefinition' ? encap : undefined;
  const { params, body } = fd
    ? functionParts(fd)
    : {
        params: isElement(encap)
          ? (Array.isArray(encap.formalParameter) ? encap.formalParameter.filter(isElement) : []).map((p) =>
              typeof p.name === 'string' ? p.name : '',
            )
          : [],
        body: isElement(encap) ? encap : undefined,
      };

  const paramTypes = (fd ? fd.formalParameter : isElement(encap) ? encap.formalParameter : undefined) as
    | DmnElement[]
    | DmnElement
    | undefined;
  const types = (Array.isArray(paramTypes) ? paramTypes : paramTypes ? [paramTypes] : [])
    .filter(isElement)
    .map((p) => (typeof p.typeRef === 'string' ? p.typeRef : undefined));

  const fn = (...args: unknown[]): unknown => {
    const bound = bindParams(params, types, args, run.index);
    // ★ 实参不符合形参声明类型 → **整个调用不适用**，结果是 null；
    //   不是把 null 传进去继续算（TCK 0082 decision_bkm_002：期望 null，不是 `null != null` 的 false）。
    if (bound === null) return null;
    const local: Record<string, unknown> = { ...closed, ...bound };
    if (!body) return null;
    return evaluateExpression(body, scopeOf(run, definitions, local));
  };
  /*
   * ★ 同理必须包成 **FEEL 函数值**：FEEL 的 `call` 用 `isFunction()` 判定，
   * 裸 JS 函数会被当成"不是函数"（TCK 0092 `bkm_003_1()(4)` 挂在这一点上）。
   */
  const f = toFeelFunction(resultName(bkm), (...args) => fn(...args) as never, params);
  Object.defineProperty(f, '$args', { value: params, enumerable: false });
  /*
   * ★ 函数缓存的键**必须**与 `run.results` 的决策值缓存分开：
   *   `runDecision(bkm)` 记的是**值**（无形参时 = body 的值），这里记的是**函数**，
   *   共用同一个 id 会让先被别的决策 require 过的 BKM 在被直接求值时返回函数。
   */
  run.results.set(`${id}#fn`, f);
  return f;
}
