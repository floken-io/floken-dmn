// 自研 XML 解析器（★ Q38：本包不引任何第三方 XML 库）。
//
// 只做**词法 + 结构**，不做校验：良构性以外的语义交给 reader（按描述符解释）。
// 必须处理的四件事（Q38 点名）：命名空间栈 / CDATA / 实体 / 注释 + 行列偏移量；
// 另有一条安全红线：**默认拒绝展开外部实体（XXE）**。
import { DmnXmlError } from '../core/errors.js';

export interface XmlPosition {
  /** 0-based 字符偏移（左闭右开，与 §5.4 的源码定位口径一致） */
  start: number;
  end: number;
  line: number;
  column: number;
}

export interface XmlNode {
  /** 原始限定名，如 `dmn:decision` */
  name: string;
  localName: string;
  prefix: string;
  /** 解析后的命名空间 URI；无命名空间时为空串 */
  ns: string;
  /** 属性：原始限定名 → 值（不含 xmlns 声明） */
  attrs: Record<string, string>;
  /** 属性：localName → 值（同 local 冲突时后者覆盖，仅用于无命名空间场景） */
  attrsByLocal: Record<string, string>;
  children: XmlNode[];
  /** 直接文本（含 CDATA 内容） */
  text: string;
  pos: XmlPosition;
}

/** 预定义实体 —— 只有这五个是 XML 自带的，其余一律视为自定义（且不展开，见下） */
const PREDEFINED: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

/**
 * 展开字符引用与预定义实体。
 *
 * ★ 安全红线（XXE）：**不解析 `<!ENTITY>`**。XML 的自定义实体只有在 DTD 里声明才成立，
 * 而外部实体（`<!ENTITY x SYSTEM "file:///…">`）正是 XXE 的载体 ——
 * 我们不读 DTD，因此任何 `&custom;` 都无法展开。这里按 §5.6「禁吞异常」：
 * 未知的实体引用**抛错**而不是原样留下，避免调用方拿到一个看起来正常的错值。
 */
function decodeEntities(raw: string, offset: number): string {
  if (!raw.includes('&')) return raw;
  return raw.replace(/&(#x?[0-9a-fA-F]+|[A-Za-z][\w.-]*);/g, (m, body: string) => {
    if (body[0] === '#') {
      const hex = body[1] === 'x' || body[1] === 'X';
      const cp = parseInt(hex ? body.slice(2) : body.slice(1), hex ? 16 : 10);
      if (!Number.isFinite(cp) || cp < 0 || cp > 0x10ffff) {
        throw new DmnXmlError({
          code: 'DMN_XML_MALFORMED',
          message: '字符引用不是合法的 Unicode 码点',
          position: { from: offset, to: offset + raw.length },
          details: { reference: m },
        });
      }
      return String.fromCodePoint(cp);
    }
    const known = PREDEFINED[body];
    if (known === undefined) {
      throw new DmnXmlError({
        code: 'DMN_XML_EXTERNAL_ENTITY',
        message: '遇到未声明的实体引用（本解析器不读 DTD，故不展开任何自定义实体）',
        position: { from: offset, to: offset + raw.length },
        hint: '把实体改成字符引用（如 &#38;），或在交给本包之前先做一次实体展开',
        details: { reference: m },
      });
    }
    return known;
  });
}

const TOKEN =
  /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>|<!DOCTYPE[^\[>]*(\[[\s\S]*?\])?\s*>|<\/[^>]*>|<[^>]*>/g;

interface RawAttrs {
  attrs: Record<string, string>;
  attrsByLocal: Record<string, string>;
  /** 本元素上声明的 xmlns（prefix → uri；默认命名空间用 ''） */
  nsDecls: Record<string, string>;
}

function parseAttrs(tagBody: string, offset: number): RawAttrs {
  const attrs: Record<string, string> = {};
  const attrsByLocal: Record<string, string> = {};
  const nsDecls: Record<string, string> = {};
  const re = /([^\s=/]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let m;
  while ((m = re.exec(tagBody)) !== null) {
    const name = m[1] ?? '';
    if (!name) continue;
    const value = decodeEntities(m[2] ?? m[3] ?? '', offset);
    if (name === 'xmlns') nsDecls[''] = value;
    else if (name.startsWith('xmlns:')) nsDecls[name.slice(6)] = value;
    else {
      attrs[name] = value;
      const local = name.includes(':') ? name.slice(name.indexOf(':') + 1) : name;
      attrsByLocal[local] = value;
    }
  }
  return { attrs, attrsByLocal, nsDecls };
}

function lineColumnOf(src: string, index: number): { line: number; column: number } {
  let line = 1;
  let last = -1;
  for (let i = 0; i < index; i += 1) {
    if (src.charCodeAt(i) === 10) {
      line += 1;
      last = i;
    }
  }
  return { line, column: index - last };
}

/**
 * 解析 XML 文本。
 *
 * @throws {DmnXmlError} 结构不闭合 / 标签不匹配 / 未声明实体 / DOCTYPE 带外部标识
 */
export function parseXml(src: string): XmlNode {
  const root: XmlNode = {
    name: '#document',
    localName: '#document',
    prefix: '',
    ns: '',
    attrs: {},
    attrsByLocal: {},
    children: [],
    text: '',
    pos: { start: 0, end: src.length, line: 1, column: 1 },
  };
  const stack: XmlNode[] = [root];
  const nsStack: Record<string, string>[] = [{}];
  /** 已见过的 DOCTYPE 里的外部标识 —— 见到就抛（XXE 载体） */
  let last = 0;
  let m;
  TOKEN.lastIndex = 0;
  while ((m = TOKEN.exec(src)) !== null) {
    const tok = m[0];
    const at = m.index;
    const top = stack[stack.length - 1] as XmlNode;

    // 文本（含转义）
    if (at > last) {
      const raw = src.slice(last, at);
      if (raw.trim()) top.text += decodeEntities(raw, last);
    }
    last = at + tok.length;

    if (tok.startsWith('<!--')) continue;
    if (tok.startsWith('<![CDATA[')) {
      top.text += tok.slice(9, -3); // CDATA 内容不转义
      continue;
    }
    if (tok.startsWith('<?')) continue;

    if (tok.startsWith('<!DOCTYPE')) {
      // ★ XXE：带 SYSTEM / PUBLIC 外部标识的 DOCTYPE 一律拒绝
      if (/\b(SYSTEM|PUBLIC)\b/.test(tok) || /<!ENTITY\b[^>]*\b(SYSTEM|PUBLIC)\b/.test(tok)) {
        throw new DmnXmlError({
          code: 'DMN_XML_EXTERNAL_ENTITY',
          message: 'DOCTYPE 含外部实体标识，已按安全策略拒绝',
          position: { from: at, to: last },
          hint: '移除 DOCTYPE 中的 SYSTEM/PUBLIC 声明后再解析',
        });
      }
      continue;
    }

    if (tok.startsWith('</')) {
      const name = tok.slice(2, -1).trim();
      if (stack.length <= 1) {
        throw new DmnXmlError({
          code: 'DMN_XML_MALFORMED',
          message: '结束标签没有对应的开始标签',
          position: { from: at, to: last },
          details: { name },
        });
      }
      const open = stack[stack.length - 1] as XmlNode;
      if (open.name !== name) {
        throw new DmnXmlError({
          code: 'DMN_XML_MALFORMED',
          message: '结束标签与开始标签不匹配',
          position: { from: at, to: last },
          details: { expected: open.name, got: name },
        });
      }
      stack.pop();
      nsStack.pop();
      (stack[stack.length - 1] as XmlNode).children.push(open);
      continue;
    }

    // 开始标签
    let body = tok.slice(1, -1);
    const selfClose = body.endsWith('/');
    if (selfClose) body = body.slice(0, -1);
    const { attrs, attrsByLocal, nsDecls } = parseAttrs(body, at);
    const qname = body.split(/\s/)[0] ?? '';
    const colon = qname.indexOf(':');
    const prefix = colon > 0 ? qname.slice(0, colon) : '';
    const localName = colon > 0 ? qname.slice(colon + 1) : qname;

    const inherited = nsStack[nsStack.length - 1] as Record<string, string>;
    const scope = Object.keys(nsDecls).length ? { ...inherited, ...nsDecls } : inherited;
    const ns = prefix ? (scope[prefix] ?? '') : (scope[''] ?? '');

    const { line, column } = lineColumnOf(src, at);
    const node: XmlNode = {
      name: qname,
      localName,
      prefix,
      ns,
      attrs,
      attrsByLocal,
      children: [],
      text: '',
      pos: { start: at, end: last, line, column },
    };
    if (selfClose) {
      top.children.push(node);
    } else {
      stack.push(node);
      nsStack.push(scope);
    }
  }

  // 收尾：栈里还有未闭合的元素
  if (stack.length > 1) {
    const open = stack[stack.length - 1] as XmlNode;
    throw new DmnXmlError({
      code: 'DMN_XML_UNCLOSED',
      message: '元素未闭合',
      position: { from: open.pos.start, to: src.length },
      details: { name: open.name },
      hint: `补上 </${open.name}>`,
    });
  }
  // 尾部文本
  if (last < src.length) {
    const raw = src.slice(last);
    if (raw.trim()) {
      throw new DmnXmlError({
        code: 'DMN_XML_MALFORMED',
        message: '根元素之后还有文本',
        position: { from: last, to: src.length },
      });
    }
  }
  if (root.children.length !== 1) {
    throw new DmnXmlError({
      code: 'DMN_XML_MALFORMED',
      message: '文档必须恰好有一个根元素',
      position: { from: 0, to: src.length },
      details: { count: root.children.length },
    });
  }
  return root.children[0] as XmlNode;
}
