// XML → 元素树（按描述符解释）。
//
// ★ 与 moddle 的关键差别：本包**不引 moddle / moddle-xml**（Q38），
// 这张描述符表（见 `spec/`）+ 本文件就是全部读写能力。
//
// 两条设计约束：
//  1. **抽象基类靠元素名反查** —— `<definitions>` 声明的属性是 `drgElement: DRGElement`，
//     但文件里写的是 `<decision>`。只靠属性声明推不出具体类型。
//  2. **未知元素走诊断不抛错** —— 换一个输入还有救（§5.1）；但 1.6 专有特性必须抛（Q35，禁静默降级）。
import type { XmlNode } from './sax.js';
import { parseXml } from './sax.js';
import { DmnModelError, DmnXmlError, diag, type Diagnostic } from '../core/errors.js';
import type { SpecProperty } from '../spec/spec-types.js';
import {
  ACCEPTED_NAMESPACES,
  BFEEL_URI_20240513,
  DMNDI_NS_20191111,
  DMNDI_NS_20230324,
  allProperties,
  findProperty,
  getType,
  isAtomicType,
  isSubtypeOf,
  typeOfElementName,
  versionOfNamespace,
} from '../spec/index.js';

/** 一个 DMN 元素。`$type` 是描述符里的类型名（不带 `dmn:` 前缀）。 */
export interface DmnElement {
  $type: string;
  $id?: string;
  [key: string]: unknown;
}

/** 解析结果：模型 + 诊断（未知元素等「还能救」的问题） */
export interface ReadResult {
  definitions: DmnElement;
  /** 文件声明的 DMN 版本（1.3 / 1.4 / 1.5 / 1.6） */
  version: string;
  namespace: string;
  diagnostics: Diagnostic[];
}

const TRUE = new Set(['true', '1']);
const FALSE = new Set(['false', '0']);

function coerceScalar(raw: string, type: string): unknown {
  if (type === 'Boolean') {
    if (TRUE.has(raw)) return true;
    if (FALSE.has(raw)) return false;
    return raw; // 非规范值原样保留，由校验层诊断
  }
  if (type === 'Number') {
    const n = Number(raw);
    return Number.isFinite(n) ? n : raw;
  }
  return raw;
}

/** 1.6 专有特性 —— 遇则抛，禁止静默降级（Q35 / AGENTS.md §3） */
function guardDmn16(root: XmlNode): void {
  const scan = (node: XmlNode) => {
    for (const [k, v] of Object.entries(node.attrsByLocal)) {
      if (k === 'importType' && v === 'ONNX') {
        throw new DmnModelError({
          code: 'DMN_MODEL_UNSUPPORTED_FEATURE',
          message: 'importType="ONNX" 是 DMN 1.6 专有特性',
          node: { id: node.attrsByLocal.id },
          hint: '本包权威版本为 DMN 1.5，请把模型转成 1.5 后再导入（不提供静默降级）',
          details: { feature: 'ONNX', introducedIn: '1.6' },
        });
      }
      if (v === BFEEL_URI_20240513) {
        throw new DmnModelError({
          code: 'DMN_MODEL_UNSUPPORTED_FEATURE',
          message: 'B-FEEL 是 DMN 1.6 引入的第二方言',
          node: { id: node.attrsByLocal.id },
          hint: '本包实现的是 FEEL（B-FEEL 不实现）；请改用 FEEL 语言 URI',
          details: { feature: 'B-FEEL', introducedIn: '1.6', attribute: k },
        });
      }
    }
    for (const c of node.children) scan(c);
  };
  scan(root);
}

function isKnownNamespace(ns: string): boolean {
  return ns in ACCEPTED_NAMESPACES || ns === DMNDI_NS_20230324 || ns === DMNDI_NS_20191111;
}

/**
 * 子元素 → 属性定义。
 *
 * ★ 抽象基类的属性名与实际元素名**不是一回事**：`<definitions>` 声明的是
 * `drgElement: DRGElement`，而文件里写的是 `<decision>` / `<inputData>`；
 * `<decision>` 下是 `expression: Expression`，文件里写的是 `<decisionTable>`。
 * 所以先按名字精确匹配，匹配不到再按「元素类型是否是属性类型的后代」匹配。
 */
function matchProperty(props: readonly SpecProperty[], child: XmlNode): SpecProperty | undefined {
  const exact = props.find((x) => !x.isAttr && x.name === child.localName);
  if (exact) return exact;
  const childType = typeOfElementName(child.localName);
  if (!childType) return undefined;
  return props.find((x) => !x.isAttr && isSubtypeOf(childType, x.type));
}

/**
 * 把 XmlNode 解释成一个 DmnElement。
 * @param declared 父属性声明的类型（可能是抽象基类），元素名能反查时以元素名为准
 */
function readElement(
  node: XmlNode,
  declared: string | undefined,
  diagnostics: Diagnostic[],
  path: string,
): DmnElement {
  const byName = typeOfElementName(node.localName);
  // 元素名反查优先：`<decision>` 能直接定到 Decision，不需要依赖父声明
  let typeName = byName ?? declared;

  if (!typeName) {
    // 既不在元素名表里、父也没声明 —— 未知元素
    diagnostics.push(
      diag('DMN_DIAG_UNKNOWN_ELEMENT', `未知元素 <${node.localName}>`, {
        node: { path },
        start: node.pos.start,
        end: node.pos.end,
      }),
    );
    return readGeneric(node, diagnostics, path);
  }

  // 元素名反查到抽象基类（如 `<some>` → Quantified 已修正，但 `drgElement` 这种不会出现在文件里）
  const t = getType(typeName);
  if (t?.isAbstract && declared && !isSubtypeOf(declared, t.name)) {
    typeName = declared;
  }

  const props = allProperties(typeName);
  const el: DmnElement = { $type: typeName };

  // --- 属性（isAttr）---
  for (const p of props) {
    if (!p.isAttr) continue;
    const raw = node.attrsByLocal[p.name];
    if (raw === undefined) continue;
    el[p.name] = isAtomicType(p.type) ? coerceScalar(raw, p.type) : raw;
  }
  const idv = el.id;
  if (typeof idv === 'string') el.$id = idv;

  // --- 子元素 ---
  for (const child of node.children) {
    const p = matchProperty(props, child);
    if (!p) {
      // 第三方扩展（Trisotech 等）或未知结构 → 诊断，不抛
      if (isKnownNamespace(child.ns) || child.ns === '') {
        diagnostics.push(
          diag('DMN_DIAG_UNKNOWN_ELEMENT', `<${typeName}> 下出现未声明的子元素 <${child.localName}>`, {
            node: { path: `${path}.${child.localName}` },
            start: child.pos.start,
            end: child.pos.end,
          }),
        );
      }
      continue;
    }
    if (p.type === 'ExtensionElements') {
      // `<xsd:any namespace="##other">` —— 保留原始节点，不做解释
      el[p.name] = child.children;
      continue;
    }
    const value = isAtomicType(p.type)
      ? coerceScalar(child.text, p.type)
      : readElement(child, p.type, diagnostics, `${path}.${p.name}`);
    if (p.isMany) {
      const arr = el[p.name];
      if (Array.isArray(arr)) arr.push(value);
      else el[p.name] = [value];
    } else {
      el[p.name] = value;
    }
  }

  // --- 纯文本元素（如 LiteralExpression 的 <text>）已由属性匹配覆盖；
  //     没有匹配到任何属性声明时，至少保留文本 ---
  if (!Object.keys(el).some((k) => k !== '$type' && k !== '$id') && node.text) el.text = node.text;

  return el;
}

/** 未知元素：保留结构与文本，便于回写时不丢内容 */
function readGeneric(node: XmlNode, diagnostics: Diagnostic[], path: string): DmnElement {
  const el: DmnElement = { $type: `x:${node.localName}` };
  for (const [k, v] of Object.entries(node.attrsByLocal)) el[k] = v;
  for (const child of node.children) {
    const value = readGeneric(child, diagnostics, `${path}.${child.localName}`);
    const arr = el[child.localName];
    if (Array.isArray(arr)) arr.push(value);
    else el[child.localName] = value;
  }
  if (node.text) el.text = node.text;
  return el;
}

/**
 * 解析一份 `.dmn`。
 *
 * @throws {DmnXmlError} XML 不闭合 / 标签不匹配 / 未声明实体 / DOCTYPE 含外部实体
 * @throws {DmnModelError} 命名空间不在 1.3~1.6 四档内、或遇 1.6 专有特性
 */
export function readDmn(xml: string): ReadResult {
  const root = parseXml(xml);
  const diagnostics: Diagnostic[] = [];

  if (root.localName !== 'definitions') {
    throw new DmnXmlError({
      code: 'DMN_XML_MALFORMED',
      message: '根元素必须是 <definitions>',
      position: { from: root.pos.start, to: root.pos.end },
      details: { got: root.localName },
    });
  }
  const version = versionOfNamespace(root.ns);
  if (!version) {
    throw new DmnModelError({
      code: 'DMN_MODEL_UNKNOWN_VERSION',
      message: '命名空间不是已知的 DMN 版本',
      node: { id: root.attrsByLocal.id },
      hint: '本包接受 DMN 1.3 / 1.4 / 1.5 / 1.6 四个命名空间',
      details: { got: root.ns || '(无命名空间)', accepted: Object.keys(ACCEPTED_NAMESPACES) },
    });
  }

  guardDmn16(root);

  const definitions = readElement(root, 'Definitions', diagnostics, 'definitions');

  // 版本信息挂到模型上，导出时据此决定是否需要改写（导出恒写 1.5）
  definitions.$version = version;
  definitions.$namespace = root.ns;

  return { definitions, version, namespace: root.ns, diagnostics };
}

/** 按 id 建立索引（href="#id" 解析用） */
export function indexById(root: DmnElement): Map<string, DmnElement> {
  const out = new Map<string, DmnElement>();
  const walk = (el: DmnElement) => {
    if (typeof el.$id === 'string' && !out.has(el.$id)) out.set(el.$id, el);
    for (const [k, v] of Object.entries(el)) {
      if (k.startsWith('$')) continue;
      if (Array.isArray(v)) {
        for (const item of v) if (isElement(item)) walk(item);
      } else if (isElement(v)) {
        walk(v);
      }
    }
  };
  walk(root);
  return out;
}

export function isElement(v: unknown): v is DmnElement {
  return typeof v === 'object' && v !== null && typeof (v as DmnElement).$type === 'string';
}
