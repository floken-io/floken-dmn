// 错误契约 —— 逐字实现 `AGENTS.md` §5（五包通用，不共享基类）。
//
// 通道（§5.1）：**抛** = 重试也救不回来；**诊断** = 换个输入还有救。
// dmn 侧特有的判据：NFR-M4「求值错误必须抛，不静默返回默认值」。
//
// 码空间（§5.3 硬约束②：抛出码与诊断码不得重叠）：
//   抛出 → `DMN_EVAL_*` / `DMN_MODEL_*` / `DMN_XML_*` / `DMN_OPTION_*`
//   诊断 → `DMN_DIAG_*`

export const PKG = 'dmn' as const;

/** 抛出的错误码（发布后不得改名，只能新增） */
export const DMN_ERROR_CODES = [
  // --- XML 层（Q38：自研读写器） ---
  'DMN_XML_MALFORMED',
  'DMN_XML_EXTERNAL_ENTITY',
  'DMN_XML_UNCLOSED',
  // --- 模型层 ---
  'DMN_MODEL_UNKNOWN_VERSION',
  'DMN_MODEL_UNSUPPORTED_FEATURE',
  'DMN_MODEL_UNKNOWN_ELEMENT',
  'DMN_MODEL_MISSING_REFERENCE',
  'DMN_MODEL_DUPLICATE_ID',
  // --- 求值层 ---
  'DMN_EVAL_NO_DECISION',
  'DMN_EVAL_CIRCULAR',
  'DMN_EVAL_HIT_POLICY',
  'DMN_EVAL_UNSUPPORTED_EXPRESSION',
  'DMN_EVAL_TYPE_CONSTRAINT',
  'DMN_EVAL_MISSING_INPUT',
  'DMN_EVAL_FEEL',
  // --- API 契约 ---
  'DMN_OPTION_INVALID',
  'DMN_NOT_LOADED_FEEL',
] as const;

export type DmnErrorCode = (typeof DMN_ERROR_CODES)[number];

/** 诊断码（可与结果共存，不抛） */
export const DMN_DIAGNOSTIC_CODES = [
  'DMN_DIAG_UNKNOWN_PROPERTY',
  'DMN_DIAG_UNKNOWN_ELEMENT',
  'DMN_DIAG_TYPE_MISMATCH',
  'DMN_DIAG_MISSING_INPUT',
  'DMN_DIAG_NO_MATCH',
] as const;

export type DmnDiagnosticCode = (typeof DMN_DIAGNOSTIC_CODES)[number];

/** `AGENTS.md` §5.5 —— 与 feel / moddle 同形 */
export interface Diagnostic {
  severity: 'error' | 'warn' | 'info';
  code: string;
  message: string;
  /** 源码定位（解析 .dmn 文本时给出；从对象树求值时为 0） */
  start: number;
  end: number;
  expected?: string[];
  suggestions?: string[];
}

export interface DmnNodeRef {
  id?: string;
  path?: string;
}

/**
 * 定位入参：允许直接传可能为 `undefined` 的 id/path（`exactOptionalPropertyTypes` 下
 * `{ id: undefined }` 不能赋给 `DmnNodeRef`，但调用点几乎都是 `el.$id ?? ''` 这种可空值）。
 * 构造时会把 undefined 字段剔除，保证 `JSON.stringify` 干净（§5.2）。
 */
export interface DmnNodeInput {
  id?: string | undefined;
  path?: string | undefined;
}

export interface DmnErrorOptions {
  code: DmnErrorCode;
  message: string;
  node?: DmnNodeInput;
  hint?: string;
  details?: Record<string, unknown>;
  cause?: unknown;
}

/**
 * 本包错误基类。§5.6 禁裸抛 —— 所有抛出必须是本类或其子类。
 * 可选字段用 `declare` 声明，保证 `JSON.stringify` 不产生 undefined 键。
 */
export class DmnError extends Error {
  override readonly name: string = 'DmnError';
  readonly code: DmnErrorCode;
  readonly pkg: typeof PKG = PKG;
  readonly floken: true = true;
  declare readonly node?: DmnNodeRef;
  declare readonly hint?: string;
  declare readonly details?: Record<string, unknown>;
  declare readonly position?: { from: number; to: number };

  constructor(opts: DmnErrorOptions) {
    super(opts.message);
    this.code = opts.code;
    const node = normalizeNode(opts.node);
    if (node) (this as { node?: DmnNodeRef }).node = node;
    if (opts.hint) (this as { hint?: string }).hint = opts.hint;
    if (opts.details) (this as { details?: Record<string, unknown> }).details = opts.details;
    if (opts.cause !== undefined) (this as unknown as { cause?: unknown }).cause = opts.cause;
  }
}

/** XML 结构非法 / 不安全（Q38 自研解析器的失败态） */
export class DmnXmlError extends DmnError {
  override readonly name = 'DmnXmlError';
  declare readonly position?: { from: number; to: number };
  constructor(
    opts: Omit<DmnErrorOptions, 'code'> & { code: 'DMN_XML_MALFORMED' | 'DMN_XML_EXTERNAL_ENTITY' | 'DMN_XML_UNCLOSED'; position?: { from: number; to: number } },
  ) {
    super(opts);
    if (opts.position) (this as { position?: { from: number; to: number } }).position = opts.position;
  }
}

/** 元模型层：版本不认、特性不支持、引用断链 */
export class DmnModelError extends DmnError {
  override readonly name = 'DmnModelError';
  constructor(
    opts: Omit<DmnErrorOptions, 'code'> & {
      code: 'DMN_MODEL_UNKNOWN_VERSION' | 'DMN_MODEL_UNSUPPORTED_FEATURE' | 'DMN_MODEL_UNKNOWN_ELEMENT' | 'DMN_MODEL_MISSING_REFERENCE' | 'DMN_MODEL_DUPLICATE_ID';
    },
  ) {
    super(opts);
  }
}

/**
 * 求值失败（对标参考实现的 `DecisionError`）。
 * ★ NFR-M4：dmn 求值错误**必须抛**，不许静默返回默认值。
 */
export class DecisionError extends DmnError {
  override readonly name = 'DecisionError';
  constructor(
    opts: Omit<DmnErrorOptions, 'code'> & {
      code:
        | 'DMN_EVAL_NO_DECISION'
        | 'DMN_EVAL_CIRCULAR'
        | 'DMN_EVAL_HIT_POLICY'
        | 'DMN_EVAL_UNSUPPORTED_EXPRESSION'
        | 'DMN_EVAL_TYPE_CONSTRAINT'
        | 'DMN_EVAL_MISSING_INPUT'
        | 'DMN_EVAL_FEEL';
    },
  ) {
    super(opts);
  }
}

/** API 契约被破坏（缺参 / 类型错 / 未知选项） */
export class DmnOptionError extends DmnError {
  override readonly name = 'DmnOptionError';
  constructor(opts: Omit<DmnErrorOptions, 'code'> & { code: 'DMN_OPTION_INVALID' | 'DMN_NOT_LOADED_FEEL' }) {
    super(opts);
  }
}

/** 全部错误子类 —— 形状一致性测试遍历它 */
export const DMN_ERROR_CLASSES = [DmnError, DmnXmlError, DmnModelError, DecisionError, DmnOptionError] as const;

/** 便于 `catch` 侧判定（跨包只看 `floken` 印记，不用 instanceof） */
export function isDmnError(e: unknown): e is DmnError {
  return typeof e === 'object' && e !== null && (e as { floken?: unknown }).floken === true && (e as { pkg?: unknown }).pkg === PKG;
}

/** 剔除 undefined 字段；全空则返回 undefined（不产生空对象键） */
function normalizeNode(input: DmnNodeInput | undefined): DmnNodeRef | undefined {
  if (!input) return undefined;
  const out: DmnNodeRef = {};
  if (input.id) out.id = input.id;
  if (input.path) out.path = input.path;
  return Object.keys(out).length ? out : undefined;
}

/** 构造诊断（不抛，随结果返回） */
export function diag(
  code: DmnDiagnosticCode,
  message: string,
  opts: { severity?: Diagnostic['severity']; node?: DmnNodeRef; start?: number; end?: number; expected?: string[] } = {},
): Diagnostic {
  const d: Diagnostic = {
    severity: opts.severity ?? 'warn',
    code,
    message,
    start: opts.start ?? 0,
    end: opts.end ?? 0,
  };
  if (opts.expected) d.expected = opts.expected;
  if (opts.node?.id || opts.node?.path) d.message = `${message}（${opts.node.path ?? opts.node.id}）`;
  return d;
}
