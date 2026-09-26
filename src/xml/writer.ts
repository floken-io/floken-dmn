// 元素树 → XML（★ 导出恒写 DMN 1.5，不随读入版本变 —— Q35）。
//
// 要点：
//  - 命名空间固定 `…/20230324/MODEL/`；`dmndi` / `dc` / `di` 一并按 1.5 写。
//  - 属性顺序按描述符（含继承，祖先优先），保证同一份模型每次导出字节一致。
//  - 未知 / 扩展内容（`x:` 前缀与 `$type` 找不到元素名的）原样保留，不静默丢弃。
import {
  DMNDI_NS_20230324,
  EXPORT_NAMESPACE,
  TYPE_TO_ELEMENT_NAME,
  allProperties,
  getType,
  isAtomicType,
} from '../spec/index.js';
import { DmnModelError } from '../core/errors.js';
import type { DmnElement } from './reader.js';
import type { XmlNode } from './sax.js';

export interface WriteOptions {
  /** 缩进；0 = 不缩进（默认 2） */
  indent?: number;
  /** XML 声明（默认带） */
  declaration?: boolean;
}

const ESCAPE_TEXT = /[&<>]/g;
const ESCAPE_ATTR = /[&<>"]/g;

function esc(s: string, forAttr: boolean): string {
  return s.replace(forAttr ? ESCAPE_ATTR : ESCAPE_TEXT, (c) =>
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : '&quot;',
  );
}

function scalarToXml(v: unknown): string {
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  return String(v);
}

function attrsOf(el: DmnElement, typeName: string): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const p of allProperties(typeName)) {
    if (!p.isAttr) continue;
    const v = el[p.name];
    if (v === undefined || v === null) continue;
    out.push([p.name, scalarToXml(v)]);
  }
  return out;
}

function writeElement(el: DmnElement, depth: number, indent: number): string[] {
  const typeName = el.$type;
  const pad = indent > 0 ? ' '.repeat(indent * depth) : '';
  const tag = TYPE_TO_ELEMENT_NAME[typeName] ?? (typeName.startsWith('x:') ? typeName.slice(2) : null);

  if (tag === null) {
    if (!getType(typeName)) {
      throw new DmnModelError({
        code: 'DMN_MODEL_UNKNOWN_ELEMENT',
        message: '导出遇到未知类型',
        node: { id: typeof el.$id === 'string' ? el.$id : undefined },
        details: { type: typeName },
      });
    }
    // 抽象基类（XML 里不能直接出现）→ 跳过自身，只回写子内容
    const lines: string[] = [];
    for (const [k, v] of Object.entries(el)) {
      if (k.startsWith('$')) continue;
      for (const item of Array.isArray(v) ? v : [v]) {
        if (isEl(item)) lines.push(...writeElement(item, depth, indent));
      }
    }
    return lines;
  }

  const attrs = attrsOf(el, typeName).map(([k, v]) => ` ${k}="${esc(v, true)}"`).join('');
  const childLines: string[] = [];

  for (const p of allProperties(typeName)) {
    if (p.isAttr) continue;
    const v = el[p.name];
    if (v === undefined || v === null) continue;
    const items = Array.isArray(v) ? v : [v];
    for (const item of items) {
      // 扩展元素：原始 XmlNode 原样回写
      if (p.type === 'ExtensionElements' && Array.isArray(item)) {
        for (const raw of item) childLines.push(...writeRaw(raw as XmlNode, depth + 1, indent));
        continue;
      }
      if (isEl(item)) {
        childLines.push(...writeElement(item, depth + 1, indent));
        continue;
      }
      // 原子类型 → 带标签的文本元素
      const childTag = TYPE_TO_ELEMENT_NAME[p.type] ?? lowerFirst(p.name);
      const text = esc(scalarToXml(item), false);
      if (indent > 0) childLines.push(`${' '.repeat(indent * (depth + 1))}<${childTag}>${text}</${childTag}>`);
      else childLines.push(`<${childTag}>${text}</${childTag}>`);
    }
  }

  // 未声明的键（第三方扩展）：保留
  const declared = new Set(allProperties(typeName).map((p) => p.name));
  for (const [k, v] of Object.entries(el)) {
    if (k.startsWith('$') || declared.has(k)) continue;
    for (const item of Array.isArray(v) ? v : [v]) {
      if (isEl(item)) childLines.push(...writeElement(item, depth + 1, indent));
      else if (item !== null && item !== undefined && isAtomicLike(item)) {
        const text = esc(scalarToXml(item), false);
        childLines.push(indent > 0 ? `${' '.repeat(indent * (depth + 1))}<${k}>${text}</${k}>` : `<${k}>${text}</${k}>`);
      }
    }
  }

  if (!childLines.length && !el.text) return [`${pad}<${tag}${attrs}/>`];
  if (typeof el.text === 'string' && !childLines.length) {
    return [`${pad}<${tag}${attrs}>${esc(el.text, false)}</${tag}>`];
  }
  return [`${pad}<${tag}${attrs}>`, ...childLines, `${pad}</${tag}>`];
}

function writeRaw(node: XmlNode, depth: number, indent: number): string[] {
  const pad = indent > 0 ? ' '.repeat(indent * depth) : '';
  const attrs = Object.entries(node.attrs)
    .map(([k, v]) => ` ${k}="${esc(v, true)}"`)
    .join('');
  if (!node.children.length && !node.text) return [`${pad}<${node.name}${attrs}/>`];
  if (!node.children.length) return [`${pad}<${node.name}${attrs}>${esc(node.text, false)}</${node.name}>`];
  const inner = node.children.flatMap((c) => writeRaw(c, depth + 1, indent));
  return [`${pad}<${node.name}${attrs}>`, ...inner, `${pad}</${node.name}>`];
}

function isEl(v: unknown): v is DmnElement {
  return typeof v === 'object' && v !== null && typeof (v as DmnElement).$type === 'string';
}
function isAtomicLike(v: unknown): boolean {
  return typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean';
}
function lowerFirst(s: string): string {
  return s.charAt(0).toLowerCase() + s.slice(1);
}

/**
 * 导出一份 `.dmn`（恒写 DMN 1.5）。
 * @throws {DmnModelError} 遇到描述符里不存在的类型
 */
export function writeDmn(definitions: DmnElement, opts: WriteOptions = {}): string {
  const indent = opts.indent ?? 2;
  const decl = opts.declaration === false ? '' : '<?xml version="1.0" encoding="UTF-8"?>\n';

  const el: DmnElement = { ...definitions };
  // 导出时的命名空间：固定 1.5
  const lines = writeElement(el, 0, indent);
  // 根元素上补命名空间声明
  const rootLine = lines[0] ?? '';
  const withNs = rootLine.replace(
    /^(\s*<definitions)/,
    `$1 xmlns="${EXPORT_NAMESPACE}" xmlns:dmndi="${DMNDI_NS_20230324}"`,
  );
  const rest = lines.slice(1);
  return decl + [withNs, ...rest].join(indent > 0 ? '\n' : '') + (indent > 0 ? '\n' : '');
}

export { isAtomicType };
