// 表达式求值委托 —— **本包不得自己实现任何求值**（`04-dmn` §14 边界第 1 条）。
//
// 只做三件事：
//  1. 把字符串 + 变量字典交给 `floken-feel`（边界第 2 条：不许把 dmn 元素对象塞进去）；
//  2. 把 `floken-feel` 的结构化错误包装成 `DMN_EVAL_FEEL`（保留 cause，不吞异常 —— §5.6）；
//  3. DMN `typeRef` → FEEL 值的类型强制（决策表输入/输出列的声明类型）。
import { evaluate, isFunction, toFeelContext, unaryTest, type Diagnostic as FeelDiagnostic, type EvaluateOptions, type TypeSpec } from 'floken-feel';
import { DecisionError, type Diagnostic } from '../core/errors.js';
import { isElement, type DmnElement } from '../xml/reader.js';

/** 普通对象 → FEEL context（盒装 context 的结果值，与 FEEL 里 `{a: 1}` 同一种值） */
export { toFeelContext, toFeelFunction } from 'floken-feel';
export { isFunction } from 'floken-feel';

/**
 * ★ FEEL 的**错误模式**（透传 `floken-feel` 的 `errorMode`，不新增概念）：
 *  - `'null'`（默认）：未知/类型不符 → `null` **并附诊断**。`decide` 的返回值里能拿到
 *    带 `start`/`end` 定位的诊断列表 —— 这是**设计器实时校验**该用的通道；
 *  - `'throw'`：未知也抛 `DMN_EVAL_FEEL`。**fail-fast**，第一个错就中断、拿不到结果值。
 *
 * ⚠️ `'throw'` 不是"更严格所以更好"：DMN 规范里 null 传播是**正常结果、不是错误**。
 * 实测 A 口径在 `'throw'` 下会掉 1 条（`0006-join#001`：filter 比较含 null → 规范给
 * unknown，严格模式误当错误）。**默认不要开**，见 `known-gaps.md` §0.2。
 */
export type FeelErrorMode = NonNullable<EvaluateOptions['errorMode']>;

/** 组装传给 `floken-feel` 的 options（可选字段一律 `?: T | undefined`） */
function feelOptions(types: Record<string, TypeSpec> | undefined, errorMode: FeelErrorMode | undefined): EvaluateOptions {
  const opts: EvaluateOptions = {};
  if (types) opts.types = types;
  if (errorMode) opts.errorMode = errorMode;
  return opts;
}

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
export function evalExpression(
  src: string,
  context: Record<string, unknown>,
  node?: { id?: string; path?: string },
  types?: Record<string, TypeSpec>,
  errorMode?: FeelErrorMode,
): FeelOutcome {
  try {
    const r = evaluate(src, context, feelOptions(types, errorMode));
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
export function evalUnaryTests(
  src: string,
  value: unknown,
  context: Record<string, unknown>,
  node?: { id?: string; path?: string },
  types?: Record<string, TypeSpec>,
  errorMode?: FeelErrorMode,
): { value: boolean | null; warnings: Diagnostic[] } {
  try {
    const r = unaryTest(src, { ...context, '?': value }, feelOptions(types, errorMode));
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

/**
 * 同一类型的**两种写法**（DMN 1.2/1.3 的 XSD 名 ↔ DMN 1.4+ 的 FEEL 名）。
 * TCK 0007-date-time 用的是 `dayTimeDuration` / `dateTime`，
 * 不认这套别名的话 `duration(durationString)` 会被当成"类型不符"强制成 null。
 */
const BASE_ALIAS: Record<string, string> = {
  dayTimeDuration: 'days and time duration',
  yearMonthDuration: 'years and months duration',
  dateTime: 'date and time',
};

/** 归一化成 DMN 1.4+ 的 FEEL 类型名 */
function canonicalType(typeRef: string): string {
  return BASE_ALIAS[typeRef] ?? typeRef;
}

export function isBaseTypeRef(typeRef: unknown): boolean {
  return typeof typeRef === 'string' && BASE_TYPES.has(typeRef);
}

/**
 * 按 `typeRef` 强制转换一个值（DMN 1.5 的 *type coercions*）。
 *
 * 五档口径（TCK 0082 / 1157 逐条钉死）：
 *  ① `typeRef` 缺席或是 `Any` → 原样返回；
 *  ② **已是目标类型** → 原样返回。⚠️ 这条必须最先判：FEEL 的 `number()` **只收 string**，
 *     `number(10)` 得 `null`，直接拿转换函数去套会把"本来就对的 10"转成 null
 *     （`literal_001` 的 `5+5` 就是这样变成 null 的）；
 *  ③ **单例列表 ↔ 标量**：`["foo"]` → `"foo"`、`"abc"` → `["abc"]`；
 *     非单例的列表要当标量用（或反过来）→ `null`（`["a","b"]` 当 string 是 null）；
 *  ④ 复合类型（`itemDefinition`）→ 按 `itemComponent` 逐个递归强制，
 *     缺任一组件或任一组件强制失败 → `null`；`isCollection` 为真时逐元素递归；
 *  ⑤ 其余（跨基本类型，如 number→string）→ `null`（**不是**硬转，也不是抛）。
 *
 * 失败一律给 `null`：这是"值不符合声明类型"，属**语义结果**而非调用错误，
 * 与 §5.6「禁用 null 表达出错」不冲突（那里禁的是用 null 掩盖异常）。
 */
export function coerceTypeRef(
  value: unknown,
  typeRef: unknown,
  node?: { id?: string; path?: string },
  index?: TypeIndex,
): unknown {
  if (typeof typeRef !== 'string' || typeRef === '' || typeRef === 'Any' || typeRef === 'any') return value;
  const t = canonicalType(typeRef);
  if (t === 'Any' || t === 'any') return value;
  if (value === null || value === undefined) return null;

  // ④ 复合类型（含集合）
  const def = index?.itemDefinitions?.get(typeRef);
  if (def) {
    /*
     * ★ `functionItem` 声明的是**函数类型**，它的 `outputTypeRef` 是**结果**类型。
     *
     * 于是「BKM 的 variable.typeRef」在 BKM **无形参**时不描述函数、而描述它的值：
     *   `To Singleton List BKM` 声明 `functionReturningNumberList`，body 是 `1`
     *   → 按 `outputTypeRef = numberList` 强制 → `[1]`（TCK 1157）。
     * 反过来，值**就是**函数时不强制（函数的输出类型由**调用时**校验，不是这里）。
     */
    const fnItem = def.functionItem;
    if (isElement(fnItem)) {
      const output = typeof fnItem.outputTypeRef === 'string' ? fnItem.outputTypeRef : '';
      if (!output || isFunctionLike(value)) return value;
      return coerceTypeRef(value, output, node, index);
    }
    return coerceComposite(value, def, index, 0);
  }

  // ⑤ 基本类型：先看是否已是
  if (isBaseTypeRef(t) && matchesBaseType(value, t)) return value;

  // ③ 单例列表 ↔ 标量
  if (Array.isArray(value)) {
    /*
     * ★ 单例解包**只解一层**（DMN 1.5 类型转换表里 `list<T> → T` 是一步转换）：
     *   `[[10]]` 解一层是 `[10]`，它**仍是列表**、不是 number → 整个强制失败。
     *   递归解包会一路剥到 10，于是 TCK 0082 invoke_005（`bkm_005([10])`，
     *   body `[arg]` = `[[10]]` 声明 number）得 10 而期望 null（errorResult）。
     */
    if (value.length === 1 && !Array.isArray(value[0])) {
      return coerceTypeRef(value[0], typeRef, node, index);
    }
    return null;
  }
  if (isBaseTypeRef(t)) return tryBaseCoercion(value, t);
  // 声明了模型里没有的类型 → 无从校验，按 §5.6 不静默改值
  return value;
}

/** 递归深度上限（防 itemDefinition 自引用把栈打爆） */
const MAX_COERCE_DEPTH = 8;

/** 复合类型（itemDefinition）强制：context 按 itemComponent 逐个递归；集合则逐元素 */
function coerceComposite(value: unknown, def: DmnElement, index: TypeIndex | undefined, depth: number): unknown {
  if (depth > MAX_COERCE_DEPTH) return null;
  const isCollection = def.isCollection === true;
  const components = (Array.isArray(def.itemComponent) ? def.itemComponent : def.itemComponent ? [def.itemComponent] : []).filter(
    (c): c is DmnElement => isElement(c),
  );

  if (isCollection) {
      const list = Array.isArray(value) ? value : [value]; // 标量 → 单例列表（TCK 1157）
      const out: unknown[] = [];
      for (const item of list) {
        /*
         * ★ **元素本身是 null** 与 **元素强制失败** 结果都是 `null`，但语义相反，必须分开：
         *   - 元素就是 null → 保留成 null。null 是 FEEL 的一等「未知」值，不是"这个元素不存在"。
         *     TCK 1161 的 `BList`（声明 `stringList`、三个输入数据都没给）期望
         *     `[null, null, null]`，不是 `null`。
         *   - 元素非 null 却强制出 null = **转换失败** → 整个列表 `null`。
         *     TCK 0082 decision_003 `[1,2,"foo"]` 声明 `tNumberList` 期望 null（errorResult），
         *     decision_006_a / literal_004 / decision_bkm_004_a 的 `"foo"` → `tNumberList` 同理。
         *   一刀切（把两者都当失败、或都当未知）会各自打掉上面一半的用例。
         */
        if (item === null || item === undefined) {
          out.push(null);
          continue;
        }
        const one = coerceComposite(item, { ...def, isCollection: false }, index, depth + 1);
        if (one === null || one === undefined) return null;
        out.push(one);
      }
      return out;
    }

  // 非集合：内层基本类型走普通强制
  const inner = typeof def.typeRef === 'string' ? def.typeRef : '';
  if (components.length === 0) return inner ? coerceTypeRef(value, inner, undefined, index) : value;

  if (!isContextLike(value)) return null;
  /*
   * ★ **保留原有全部成员**，只把声明过的组件换成强制后的值。
   * 不是"只留声明组件"：TCK 0082 decision_004 声明 `tNameAndAge`（只有 name/age
   * 两个 itemComponent），期望结果却是 `{name, surname, age}` —— 过滤会丢掉 surname。
   * 多余成员不参与校验，也不该被抹掉。
   */
  const out: Record<string, unknown> = { ...entriesOf(value) };
  for (const c of components) {
    const name = typeof c.name === 'string' ? c.name : '';
    if (!name) continue;
    const got = getMember(value, name);
    const want = typeof c.typeRef === 'string' ? c.typeRef : '';
    /*
     * ★ **缺这个键** 与 **键在但值是 null** 是两回事：
     *   - 缺键 = 结构不达标 → 整个复合值 `null`（TCK 0082 decision_005：
     *     声明 `tNameAndAge` 却只给了 `{name: "foo"}`）；
     *   - 值是 null = FEEL 的一等「未知」值，**不是**缺失，要保留下来交给后续比较
     *     （TCK 0007 `Date` 的 `fromDateTime` 是 null，但 `fromString` 还得能用 ——
     *      一刀切会把整个 `Date` 打成 null，连带 cDay/cYear/cMonth 一起塌）。
     */
    if (!(name in out)) return null;
    const one = want ? coerceTypeRef(got, want, undefined, index) : got;
    if (one === undefined) return null;
    out[name] = one;
  }
  return toFeelContext(out);
}

/** context（FEEL 或普通对象）→ 普通键值对 */
function entriesOf(v: unknown): Record<string, unknown> {
  if (v && typeof v === 'object' && (v as { __feelContext?: unknown }).__feelContext === true) {
    const m = (v as { entries?: ReadonlyMap<string, unknown> }).entries;
    const out: Record<string, unknown> = {};
    if (m) for (const [k, x] of m) out[k] = x;
    return out;
  }
  return { ...(v as Record<string, unknown>) };
}

function isContextLike(v: unknown): boolean {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** 值是否是个"可调用的东西"（FEEL 函数值或裸 JS 函数） */
function isFunctionLike(v: unknown): boolean {
  return typeof v === 'function' || isFunction(v as never);
}

function getMember(v: unknown, name: string): unknown {
  if (v && typeof v === 'object' && (v as { __feelContext?: unknown }).__feelContext === true) {
    return (v as { get?: (k: string) => unknown }).get?.(name) ?? null;
  }
  return (v as Record<string, unknown>)[name] ?? null;
}

/** 值是否已经是某个基本类型 */
function matchesBaseType(v: unknown, typeRef: string): boolean {
  switch (typeRef) {
    case 'number':
      return typeof v === 'number';
    case 'string':
      return typeof v === 'string';
    case 'boolean':
      return typeof v === 'boolean';
    case 'date':
    case 'time':
    case 'dateTime':
    case 'date and time':
    case 'days and time duration':
    case 'years and months duration': {
      const t = v as { __feelTemporal?: unknown; kind?: string } | null;
      if (!t || t.__feelTemporal !== true) return false;
      if (typeRef === 'date and time') return t.kind === 'dateTime';
      if (typeRef === 'dateTime') return t.kind === 'dateTime';
      if (typeRef === 'days and time duration' || typeRef === 'years and months duration') {
        return (t as { category?: string }).category === typeRef || t.kind === 'duration';
      }
      return t.kind === typeRef;
    }
    default:
      return false;
  }
}

/**
 * ⑤ 最后兜底：**只有规范认的隐式转换**才做（DMN 1.5 §10.3.2），失败或不在表内 → null。
 *
 *  - `string` → `number` / `date` / `time` / `date and time` / `duration`：走 FEEL 的解析函数；
 *  - `date` → `date and time`：补当日 `00:00:00`（TCK 1157 "From Date To Date and Time"）；
 *  - **反向一律不做**：`number → string` 是 TCK 0082 decision_001，期望 `null`，
 *    而 `string(2)` 会得出 `"2"` —— 拿 FEEL 转换函数无差别兜底就会在这里"救"出错误结果。
 */
function tryBaseCoercion(value: unknown, typeRef: string): unknown {
  if (typeof value !== 'string') {
    if (typeRef === 'date and time' || typeRef === 'dateTime') {
      const t = value as { __feelTemporal?: unknown; kind?: string } | null;
      if (t?.__feelTemporal === true && t.kind === 'date') {
        try {
          /*
           * ★ **`date` 隐含 UTC**（TCK 1157 "From Date To Date and Time" 期望
           *   `2000-01-02T00:00:00Z`，不是 `2000-01-02T00:00:00`）。
           *
           *   故第 4 个实参必须给一个**零偏移**：`time(0,0,0,duration("PT0H"))` 会带
           *   `+00:00`，经 `zoneSuffix` 归一成 `Z`。只写 `time(0,0,0)` 是不带偏移的
           *   本地时间 —— 与"date 是 UTC 上的一天"不是一回事，`.time offset` 与
           *   和别的 dateTime 相减都会跟着错。
           */
          return evaluate('date and time(v, time(0, 0, 0, duration("PT0H")))', { v: value }).value ?? null;
        } catch {
          return null;
        }
      }
    }
    return null;
  }
  const fn = TYPE_COERCIONS[typeRef];
  if (!fn) return null;
  try {
    return evaluate(fn, { v: value }).value ?? null;
  } catch {
    return null;
  }
}

/** 类型强制需要的模型信息（只有 itemDefinition 表，保持窄接口） */
export interface TypeIndex {
  itemDefinitions?: Map<string, DmnElement>;
}

// --------------------------------------------------------------------------
// itemDefinition 表 → FEEL 类型规格表（`instance of <itemDefinition 名>` 用）
// --------------------------------------------------------------------------

/** 自引用保护上限（itemDefinition 可以互相指向） */
const MAX_SPEC_DEPTH = 8;

const ANY_SPEC: TypeSpec = { kind: 'named', name: 'Any', start: 0, end: 0 };

/**
 * 把模型的 `itemDefinition` 表翻译成 `floken-feel` 的**类型规格表**。
 *
 * `instance of t255` / `instance of tNumberList` 这类表达式只有在拿到模型定义时才判得
 * 了 —— 名字对 FEEL 而言只是一个 `named` 规格，查表在宿主手里（TCK 0070 整组靠它）。
 *
 * 三条口径（都由 TCK 0070 钉死）：
 *  ① **`allowedValues` 不参与类型判定**（`number_013`：`256 instance of t255` → true，
 *     尽管 256 不在 `[0..255]` 里；`string_013` 同理）—— 故这里**根本不读**这两个属性；
 *  ② `isCollection="true"` → `list<内层>`，`[] instance of tAnyList` 靠这条成立
 *     （`list_014_a`：空列表对每个元素类型都成立）；
 *  ③ `itemComponent` → `context<…>`；`functionItem` → `function<…>`。
 *
 * 查不到的名字按 `named` 交给 FEEL：它先查内建类型（`number`/`string`/`Any`…），
 * 再查本表，都落空才判 `false`。
 */
export function buildTypeSpecs(itemDefinitions: Map<string, DmnElement>): Record<string, TypeSpec> {
  const out: Record<string, TypeSpec> = {};
  for (const [name, def] of itemDefinitions) out[name] = specOfItemDefinition(def, itemDefinitions, 0);
  return out;
}

function specOfItemDefinition(
  def: DmnElement,
  table: Map<string, DmnElement>,
  depth: number,
): TypeSpec {
  if (depth > MAX_SPEC_DEPTH) return ANY_SPEC;

  // `functionItem` 声明的是**函数类型**：`outputTypeRef` 是结果类型
  const fnItem = def.functionItem;
  if (isElement(fnItem)) {
    const output = typeof fnItem.outputTypeRef === 'string' && fnItem.outputTypeRef ? fnItem.outputTypeRef : '';
    return { kind: 'function', result: output ? resolveRef(output, table, depth) : null, start: 0, end: 0 };
  }

  const components = (Array.isArray(def.itemComponent) ? def.itemComponent : def.itemComponent ? [def.itemComponent] : []).filter(
    (c): c is DmnElement => isElement(c),
  );
  let inner: TypeSpec;
  if (components.length > 0) {
    const entries: { key: string; type: TypeSpec }[] = [];
    for (const c of components) {
      const key = typeof c.name === 'string' ? c.name : '';
      if (!key) continue;
      const ref = typeof c.typeRef === 'string' && c.typeRef ? c.typeRef : '';
      entries.push({ key, type: ref ? resolveRef(ref, table, depth) : ANY_SPEC });
    }
    inner = { kind: 'context', entries, start: 0, end: 0 };
  } else {
    const ref = typeof def.typeRef === 'string' && def.typeRef ? def.typeRef : '';
    inner = ref ? resolveRef(ref, table, depth) : ANY_SPEC;
  }

  return def.isCollection === true ? { kind: 'list', item: inner, start: 0, end: 0 } : inner;
}

/** 一个 `typeRef` 字符串 → 类型规格：先查模型表（可递归），否则交给 FEEL 的 `named` */
function resolveRef(ref: string, table: Map<string, DmnElement>, depth: number): TypeSpec {
  const def = table.get(ref);
  return def ? specOfItemDefinition(def, table, depth + 1) : { kind: 'named', name: ref, start: 0, end: 0 };
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
