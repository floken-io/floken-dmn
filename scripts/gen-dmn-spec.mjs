#!/usr/bin/env node
// 一次性代码生成：DMN 1.5 元模型描述符 —— **不进依赖链、不进 npm files**。
//
// 权威源：
//   ① OMG `DMN15.xsd` 原件（https://www.omg.org/spec/DMN/20230324/DMN15.xsd）
//      —— 提供 50 个 complexType 的继承、属性、基数，以及 40 个顶层 element 声明
//      （substitutionGroup 决定 Expression 的后代，abstract 决定抽象基类）。
//   ② OMG `DMNDI15.xsd` 原件 —— 图形交换（DMNDI），引擎不读，但读写器要能透传。
//   ③ `dmn-moddle@12.2.1` 的 `dmn13.json`（MIT，仅本机）—— **只用于命名对齐校验**，
//      不参与生成：1.3 的 46 个类型名与 1.5 去前缀名的唯一差异是
//      `OrganizationUnit` ↔ `OrganisationalUnit`。
//
// 用法：
//   node scripts/gen-dmn-spec.mjs [--xsd <DMN15.xsd>] [--di <DMNDI15.xsd>]
//                                 [--moddle13 <dmn13.json>] [--out <目录>] [--check]
//   --check：只比对不写盘，产物不一致 → exit 1。
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const WS = join(HERE, '..', '..', '..'); // 流程引擎开发/
const SANDBOX = join(WS, '.workbuddy', '_bpmn-sandbox');

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const XSD = arg('xsd', join(SANDBOX, 'xsd', 'DMN15.xsd'));
const DI_XSD = arg('di', join(SANDBOX, 'xsd', 'DMNDI15.xsd'));
const MODDLE13 = arg('moddle13', join(SANDBOX, 'node_modules', 'dmn-moddle', 'resources', 'dmn', 'json', 'dmn13.json'));
const OUT = arg('out', join(HERE, '..', 'src', 'spec'));
const CHECK = process.argv.includes('--check');

for (const [label, p] of [['DMN15.xsd', XSD], ['DMNDI15.xsd', DI_XSD]]) {
  if (!existsSync(p)) {
    console.error(`✗ 缺 ${label}（${p}）`);
    console.error('  生成脚本依赖 OMG XSD 原件；缺源时应当**跳过**而不是产出可疑产物。');
    process.exit(2);
  }
}

// ---------------------------------------------------------------------------
// 极简 XML → 树（**仅 build 期**；运行时解析器是 src/xml/sax.ts，两者独立）
// ---------------------------------------------------------------------------

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function decodeEntities(s) {
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (m, body) => {
    if (body[0] === '#') {
      const cp = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(cp) ? String.fromCodePoint(cp) : m;
    }
    return ENTITIES[body] ?? m;
  });
}

/**
 * 基于 token 的解析（正则保证每次匹配都前进，不会原地打转）。
 * @returns {{name:string,attrs:Record<string,string>,children:any[],text:string}}
 */
const XML_TOKEN = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>|<!DOCTYPE[^>]*>|<\/[^>]*>|<[^>]*>/g;

function parseXml(src) {
  const root = { name: '#root', attrs: {}, children: [], text: '' };
  const stack = [root];
  let last = 0;
  let m;
  while ((m = XML_TOKEN.exec(src)) !== null) {
    const tok = m[0];
    // 标签之间的文本
    if (m.index > last) {
      const text = src.slice(last, m.index).trim();
      if (text) stack[stack.length - 1].text += decodeEntities(text);
    }
    last = m.index + tok.length;

    if (tok.startsWith('<!--') || tok.startsWith('<?') || tok.startsWith('<!DOCTYPE')) continue;
    if (tok.startsWith('<![CDATA[')) {
      stack[stack.length - 1].text += tok.slice(9, -3);
      continue;
    }
    if (tok.startsWith('</')) {
      if (stack.length > 1) stack.pop();
      continue;
    }
    let tag = tok.slice(1, -1);
    const selfClose = tag.endsWith('/');
    if (selfClose) tag = tag.slice(0, -1);
    const attrs = {};
    for (const a of tag.matchAll(/([^\s=/]+)\s*=\s*"([^"]*)"/g)) attrs[a[1]] = decodeEntities(a[2]);
    const name = tag.split(/\s/)[0];
    const node = { name, attrs, children: [], text: '' };
    stack[stack.length - 1].children.push(node);
    if (!selfClose) stack.push(node);
  }
  return root;
}

const localName = (n) => n.split(':').pop();
const kids = (node, name) => node.children.filter((c) => localName(c.name) === name);
const kid = (node, name) => kids(node, name)[0];

// ---------------------------------------------------------------------------
// XSD → 中间模型
// ---------------------------------------------------------------------------

/** XSD 的 t* 类型名 → moddle 描述符名（唯一差异已登记） */
const TYPE_NAME_OVERRIDES = { tOrganizationUnit: 'OrganisationalUnit' };
function typeName(xsdName) {
  if (TYPE_NAME_OVERRIDES[xsdName]) return TYPE_NAME_OVERRIDES[xsdName];
  return xsdName.replace(/^t/, '');
}

/** XSD 内置 → moddle 原子类型 */
const BUILTIN_TYPES = {
  string: 'String',
  ID: 'String',
  IDREF: 'String',
  anyURI: 'String',
  QName: 'String',
  NCName: 'String',
  boolean: 'Boolean',
  decimal: 'Number',
  integer: 'Number',
  double: 'Number',
  float: 'Number',
  int: 'Number',
  dateTime: 'String',
};

function typeRefOf(raw) {
  if (!raw) return 'String';
  const n = localName(raw);
  if (BUILTIN_TYPES[n]) return BUILTIN_TYPES[n];
  return typeName(n);
}

/**
 * 元素 → 属性类型。XSD 里有些 element 写的是**匿名 complexType**（没有 `type=`），
 * 只能按名字认：`extensionElements` 就是那个装任意扩展元素的容器。
 */
const ANONYMOUS_ELEMENT_TYPES = { extensionElements: 'ExtensionElements' };
function propertyType(elementName, rawType) {
  return ANONYMOUS_ELEMENT_TYPES[elementName] ?? typeRefOf(rawType);
}

function extractTypes(xsdSrc) {
  const root = parseXml(xsdSrc);
  const schema = root.children.find((c) => localName(c.name) === 'schema');
  if (!schema) throw new Error('XSD 里找不到 <xsd:schema>');

  // 顶层 element 声明：决定「谁能出现在 XML 里」以及抽象性
  const elements = kids(schema, 'element').map((e) => ({
    name: e.attrs.name,
    type: e.attrs.type,
    abstract: e.attrs.abstract === 'true',
    substitutionGroup: e.attrs.substitutionGroup,
  }));
  const elementByName = new Map(elements.map((e) => [e.name, e]));

  // complexType
  const types = [];
  for (const ct of kids(schema, 'complexType')) {
    const xsdName = ct.attrs.name;
    if (!xsdName) continue; // 匿名 complexType（属性内联）不生成类型
    const name = typeName(xsdName);

    // 继承：complexContent/extension@base
    const ext = kid(kid(ct, 'complexContent') ?? ct, 'extension');
    const superClass = ext?.attrs.base ? [typeName(localName(ext.attrs.base))] : [];

    const properties = [];
    const body = ext ?? ct;
    // `ref="xxx"` 指向顶层 element 声明，取它的 type 才是真类型名（否则会拿到小写的 element 名）
    const refType = (ref) => elementByName.get(localName(ref))?.type ?? ref;
    // 序列里的 element —— 逐个扫（含嵌套 sequence/choice）
    const walkElements = (node) => {
      for (const child of node.children) {
        const ln = localName(child.name);
        if (ln === 'sequence' || ln === 'choice' || ln === 'all' || ln === 'group') {
          walkElements(child);
          continue;
        }
        if (ln !== 'element') continue;
        const ref = child.attrs.ref;
        const pName = ref ? localName(ref) : child.attrs.name;
        if (!pName) continue;
        const isMany = child.attrs.maxOccurs === 'unbounded';
        properties.push({
          name: pName,
          type: propertyType(pName, ref ? refType(ref) : child.attrs.type),
          isMany,
          isAttr: false,
        });
      }
    };
    walkElements(body);
    // 直接在 complexType 下的 element（无 sequence 包裹）
    for (const child of body.children) {
      if (localName(child.name) !== 'element') continue;
      const ref = child.attrs.ref;
      const pName = ref ? localName(ref) : child.attrs.name;
      if (properties.some((p) => p.name === pName)) continue;
      properties.push({
        name: pName,
        type: propertyType(pName, ref ? refType(ref) : child.attrs.type),
        isMany: child.attrs.maxOccurs === 'unbounded',
        isAttr: false,
      });
    }
    // attribute 声明
    for (const attr of kids(body, 'attribute')) {
      const aName = attr.attrs.name ?? localName(attr.attrs.ref ?? '');
      if (!aName) continue;
      if (properties.some((p) => p.name === aName && p.isAttr)) continue;
      properties.push({ name: aName, type: typeRefOf(attr.attrs.type ?? attr.attrs.ref), isAttr: true, isMany: false });
    }

    // 抽象判定：complexType@abstract ∪ 同名 element@abstract ∪ **无 element 声明**
    // （后者是 OMG 的惯例：抽象基类只有 substitutionGroup 成员，自身不可实例化）
    const declaring = elementByName.get(xsdName.replace(/^t/, (s) => s) ) ?? null;
    const el = elements.find((e) => e.type === xsdName);
    const isAbstract =
      ct.attrs.abstract === 'true' ||
      el?.abstract === true ||
      // tIterator / tQuantified 没有任何顶层 element 声明 → 抽象
      (!el && /^t(Iterator|Quantified)$/.test(xsdName));

    types.push({ name, xsdName, superClass, properties, isAbstract, declaredBy: el?.name ?? null });
  }

  // simpleType → 枚举
  const enums = [];
  for (const st of kids(schema, 'simpleType')) {
    const name = st.attrs.name;
    if (!name) continue;
    const values = kids(kid(st, 'restriction') ?? st, 'enumeration').map((e) => e.attrs.value);
    if (values.length) enums.push({ name: typeName(name), values });
  }

  return { types, enums, elements };
}

// ---------------------------------------------------------------------------
// 补 1.5 专属内容（XSD 表达不到或需显式声明的）
// ---------------------------------------------------------------------------

/** `ItemDefinition.typeConstraint`（DMN 1.5 引入，§14.1 第 3 条：在锁内 = 必做项） */
function addTypeConstraint(types) {
  const item = types.find((t) => t.name === 'ItemDefinition');
  if (!item) throw new Error('描述符缺 ItemDefinition');
  if (item.properties.some((p) => p.name === 'typeConstraint')) return false;
  item.properties.push({ name: 'typeConstraint', type: 'UnaryTests', isAttr: false, isMany: false });
  return true;
}

/**
 * `Some` / `Every` —— XSD 里只是两个 element 声明（`type="tQuantified"`），
 * 需补成具体类型；反过来 `tQuantified` 因此成为**抽象基类**（它自己不可实例化）。
 */
function addQuantifiedInstances(types) {
  const q = types.find((t) => t.name === 'Quantified');
  if (!q) throw new Error('描述符缺 Quantified');
  let added = false;
  for (const name of ['Some', 'Every']) {
    if (types.some((t) => t.name === name)) continue;
    types.push({
      name,
      xsdName: `t${name}`,
      superClass: ['Quantified'],
      properties: [],
      isAbstract: false,
      declaredBy: name.toLowerCase(),
    });
    added = true;
  }
  if (!q.isAbstract) {
    q.isAbstract = true; // some / every 才是可实例化的（XSD 里两个 element 共用 tQuantified）
    added = true;
  }
  return added;
}

/** moddle 基础设施类型（不来自 XSD，但读写器需要） */
const INFRA_TYPES = [
  { name: 'Element', superClass: [], properties: [], isAbstract: true },
  {
    name: 'ExtensionElements',
    superClass: ['Element'],
    properties: [{ name: 'values', type: 'Element', isAttr: false, isMany: true }],
    isAbstract: false,
  },
  {
    name: 'ExtensionAttribute',
    superClass: ['Element'],
    properties: [
      { name: 'name', type: 'String', isAttr: true, isMany: false },
      { name: 'value', type: 'String', isAttr: true, isMany: false },
    ],
    isAbstract: false,
  },
];

function addInfrastructure(types) {
  let added = false;
  for (const t of INFRA_TYPES) {
    if (types.some((x) => x.name === t.name)) continue;
    types.push({ ...t, xsdName: null, declaredBy: null });
    added = true;
  }
  return added;
}

// ---------------------------------------------------------------------------
// 交叉校验（对 1.3 描述符 + 文档口径）
// ---------------------------------------------------------------------------

function audit(types, enums, moddle13Path) {
  const problems = [];
  const notes = [];

  // ① 规模：文档口径「DMN 1.5 = 55 类型」= XSD 50 complexType + Some/Every(2)
  //    + moddle 基础设施 Element/ExtensionElements/ExtensionAttribute(3)。
  //    （1.3 的 46 = 43 XSD complexType + 同样这 3 个基础设施，口径一致。）
  if (types.length !== 55) problems.push(`类型总数 ${types.length} ≠ 55（文档口径：50 complexType + Some/Every + 3 基础设施）`);

  // ② 与 1.3 描述符比对：46 个名字必须都能对上，差异只能是 1.4/1.5 新增
  if (existsSync(moddle13Path)) {
    const j = JSON.parse(readFileSync(moddle13Path, 'utf8'));
    const names13 = new Set(j.types.map((t) => t.name));
    const names15 = new Set(types.map((t) => t.name));
    const lost = [...names13].filter((n) => !names15.has(n));
    if (lost.length) problems.push(`相对 1.3 丢了类型: ${lost.join(', ')}`);
    const gained = [...names15].filter((n) => !names13.has(n));
    notes.push(`1.3→1.5 新增 ${gained.length} 个: ${gained.sort().join(', ')}`);
  } else {
    notes.push('dmn13.json 不在本机，跳过命名对齐校验');
  }

  // ③ 属性数：文档口径 121+ 自有属性（dmn: 命名空间，含 typeConstraint）
  const ownProps = types.reduce((n, t) => n + t.properties.length, 0);
  if (ownProps < 121) problems.push(`自有属性 ${ownProps} < 121（文档口径）`);

  // ④ Expression 的后代（substitutionGroup=expression）必须全部在描述符里
  const exprChildren = types
    .filter((t) => t.declaredBy && /^(literalExpression|invocation|decisionTable|context|functionDefinition|relation|list|for|every|some|conditional|filter)$/.test(t.declaredBy))
    .map((t) => t.name);
  notes.push(`Expression 后代 ${exprChildren.length} 个: ${exprChildren.sort().join(', ')}`);

  // ⑤ 抽象类型不得出现在可实例化清单里
  const abstract = types.filter((t) => t.isAbstract).map((t) => t.name);
  notes.push(`抽象 ${abstract.length} 个: ${abstract.sort().join(', ')}`);
  notes.push(`可实例化 ${types.length - abstract.length} 个`);

  return { problems, notes, dmnTypes: types.length, ownProps, enums: enums.length };
}

// ---------------------------------------------------------------------------
// 产出 .ts
// ---------------------------------------------------------------------------

function emit(types, enums, meta, outFile) {
  const L = [];
  L.push('// 自动生成 —— **不要手改**。改源后跑 `node scripts/gen-dmn-spec.mjs`。');
  L.push(`// 权威源：OMG ${meta.source}（complexType + 顶层 element 声明 + simpleType 枚举）。`);
  L.push(`// 生成时间：${new Date().toISOString().slice(0, 10)}（仅记录，不参与 --check 比对）`);
  L.push('');
  L.push("import type { SpecProperty, SpecType } from './spec-types.js';");
  L.push('');
  L.push(`/** ${meta.title} */`);
  L.push('export const SPEC_TYPES: readonly SpecType[] = ');
  L.push(JSON.stringify(types.map((t) => ({
    name: t.name,
    superClass: t.superClass,
    properties: t.properties.map((p) => {
      const o = { name: p.name, type: p.type };
      if (p.isAttr) o.isAttr = true;
      if (p.isMany) o.isMany = true;
      return o;
    }),
    ...(t.isAbstract ? { isAbstract: true } : {}),
  })), null, 2) + ';');
  L.push('');
  L.push(`export const SPEC_TYPE_BY_NAME: Readonly<Record<string, SpecType>> = Object.fromEntries(`);
  L.push('  SPEC_TYPES.map((t) => [t.name, t]),');
  L.push(');');
  L.push('');
  if (enums.length) {
    L.push(`/** ${meta.title} 枚举（来自 XSD simpleType） */`);
    L.push('export const SPEC_ENUMS: Readonly<Record<string, readonly string[]>> = ');
    L.push(JSON.stringify(Object.fromEntries(enums.map((e) => [e.name, e.values])), null, 2) + ';');
    L.push('');
  }
  L.push('/** 可实例化的类型名（抽象基类不在内） */');
  L.push('export const CONCRETE_TYPES: readonly string[] = SPEC_TYPES.filter((t) => !t.isAbstract).map((t) => t.name);');
  L.push('');
  L.push('/** 全部自有属性数（规格自证用） */');
  L.push('export const OWN_PROPERTY_COUNT: number = SPEC_TYPES.reduce((n, t) => n + t.properties.length, 0);');
  L.push('');
  if (meta.elementNames && Object.keys(meta.elementNames).length) {
    L.push('/**');
    L.push(' * **XML 元素名 → 类型名**。');
    L.push(' *');
    L.push(' * ★ 这是 reader 解析**抽象基类**的唯一切入点：`<definitions>` 下的属性声明是');
    L.push(' * `drgElement: DRGElement`（抽象），而文件里写的实际是 `<decision>` / `<inputData>`。');
    L.push(' * 只靠属性声明无法确定具体类型，必须按元素名反查。');
    L.push(' */');
    L.push('export const ELEMENT_NAME_TO_TYPE: Readonly<Record<string, string>> = ');
    L.push(JSON.stringify(meta.elementNames, null, 2) + ';');
    L.push('');
  }
  const body = L.join('\n');
  if (CHECK) {
    if (!existsSync(outFile)) return { changed: true, reason: '产物不存在' };
    const cur = readFileSync(outFile, 'utf8');
    // 忽略生成时间行
    const norm = (s) => s.split('\n').filter((l) => !l.startsWith('// 生成时间：')).join('\n');
    return { changed: norm(cur) !== norm(body) };
  }
  mkdirSync(dirname(outFile), { recursive: true });
  writeFileSync(outFile, body);
  return { changed: false };
}

// 元素名 → 类型名：顶层 element 声明（含 substitutionGroup 后代）+ 描述符里补的具体类型。
// 抽象 element（abstract="true"）自身不可实例化，不进表 —— 但它的**后代**要进。
function buildElementNames(types, elements) {
  const out = {};
  for (const el of elements) {
    if (el.abstract) continue;
    const t = typeName(localName(el.type ?? ''));
    if (types.some((x) => x.name === t)) out[el.name] = t;
  }
  // 描述符里的具体类型**覆盖**同名登记 —— `some`/`every` 在 XSD 里共用 `tQuantified`，
  // 只有这里能还原成 Some / Every（否则会被解析成抽象基类）
  for (const t of types) {
    if (t.isAbstract || !t.declaredBy) continue;
    out[t.declaredBy] = t.name;
  }
  return out;
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

const dmn = extractTypes(readFileSync(XSD, 'utf8'));
const di = extractTypes(readFileSync(DI_XSD, 'utf8'));

const augment = [];
if (addTypeConstraint(dmn.types)) augment.push('ItemDefinition.typeConstraint（1.5）');
if (addQuantifiedInstances(dmn.types)) augment.push('Some/Every（tQuantified 实例）');
if (addInfrastructure(dmn.types)) augment.push('moddle 基础设施 Element/ExtensionElements/ExtensionAttribute');

const report = audit(dmn.types, dmn.enums, MODDLE13);

console.log('=== DMN 1.5 描述符生成 ===');
console.log(`源: ${XSD}`);
console.log(`DMN 类型 ${report.dmnTypes}（含基础设施共 ${dmn.types.length}）/ 自有属性 ${report.ownProps} / 枚举 ${report.enums}`);
console.log(`DMNDI 类型 ${di.types.length} / 自有属性 ${di.types.reduce((n, t) => n + t.properties.length, 0)}`);
console.log(`追加项: ${augment.join('、')}`);
for (const n of report.notes) console.log(`  · ${n}`);

if (report.problems.length) {
  for (const p of report.problems) console.error(`  ✗ ${p}`);
  process.exit(1);
}

const outDmn = join(OUT, 'dmn.generated.ts');
const outDi = join(OUT, 'dmndi.generated.ts');
const r1 = emit(dmn.types, dmn.enums, {
  source: 'DMN15.xsd',
  title: 'DMN 1.5 语义元模型（`https://www.omg.org/spec/DMN/20230324/MODEL/`）',
  elementNames: buildElementNames(dmn.types, dmn.elements),
}, outDmn);
const r2 = emit(di.types, di.enums, {
  source: 'DMNDI15.xsd',
  title: 'DMN 1.5 图形交换（`https://www.omg.org/spec/DMN/20230324/DMNDI/`）',
  elementNames: buildElementNames(di.types, di.elements),
}, outDi);

if (CHECK) {
  if (r1.changed || r2.changed) {
    const which = [r1.changed ? 'dmn.generated.ts' : null, r2.changed ? 'dmndi.generated.ts' : null].filter(Boolean);
    console.error(`✗ --check：产物与源不一致（${which.join(', ')}），请重跑生成`);
    process.exit(1);
  }
  console.log('✓ --check：产物与源一致');
} else {
  console.log(`✓ 已写出 ${outDmn}`);
  console.log(`✓ 已写出 ${outDi}`);
}
