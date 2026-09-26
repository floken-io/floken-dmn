#!/usr/bin/env node
// DMN TCK 运行器（工-B）—— **自研**，不沿用 `dmn-elements/scripts/tck/run.js`。
//
// ★ 为什么不抄（Q27）：运行器定义「什么叫通过」。`run.js` 是**作者私人诊断脚本**，
//   **不是**官方运行器 —— 官方 runner 在 `dmn-tck/tck/runners/`（全是 Java/Maven）。
//   Q27 反对的是它**自创**的 `max(1e-8, |e|*1e-9)`（随期望值放大的相对容差）。
//
// ★ 数字比较采用**官方 runner 口径**：绝对容差 `1e-8`（见 `sameNumber` 上方注释）。
//   源码实证（4 处同值）+ issue #609 维护者明文 —— 不是我们自己发明的容差。
//   - **`errorResult="true"` 的 resultNode 不豁免**（TCK 的「期望错误/未知结果」用例）：
//     判据是"没算出具体值" —— null 或抛错都算过，**给出具体值才是真错**。
//     ⚠️ 早期注释曾写成「一律 IGNORED」，与代码不符（2026-09-26 已订正，以代码为准）。
//
// A 口径（完整 DMN TCK，走 DRG）≠ `floken-feel` 的 B 口径（FEEL-only）—— 两套数字禁止互相引用。
//
// 用法：
//   node tooling/tck/run.mjs [--dir <TestCases>] [--level 2|3] [--label <关键字>] [--verbose] [--json]
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, basename, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// ★ 别用 `new URL(...).pathname` —— 中文路径会被百分号编码，随后 join 出来的路径找不到
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const WS = join(ROOT, '..', '..');

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const TCK_DIR = arg('dir', join(WS, '.workbuddy', '_bpmn-sandbox', 'tck', 'full', 'tck-master', 'TestCases'));
const LEVEL = arg('level', '');
const LABEL_FILTER = arg('label', '');
const VERBOSE = process.argv.includes('--verbose');
const AS_JSON = process.argv.includes('--json');
const LIMIT = Number(arg('limit', '0'));

if (!existsSync(TCK_DIR)) {
  console.error(`✗ 语料目录不存在：${TCK_DIR}`);
  console.error('  语料**不随包分发**（CC BY-SA 有传染性，见 04-dmn §4.3），需自备。');
  process.exit(2);
}

const DIST = join(ROOT, 'dist', 'index.js');
if (!existsSync(DIST)) {
  console.error('✗ 未构建：先跑 `node node_modules/tsup/dist/cli-node.js`');
  process.exit(2);
}
const dmn = await import(pathToFileURL(DIST).href);
const feel = await import('floken-feel');

// ---------------------------------------------------------------------------
// 极简 XML → 树（运行器自用；本包的正式解析器在 dist 里，但这里需要读 testcase 命名空间）
// ---------------------------------------------------------------------------
const TOKEN = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>|<!DOCTYPE[^>]*>|<\/[^>]*>|<[^>]*>/g;
const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const dec = (s) => s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (m, b) => {
  if (b[0] === '#') return String.fromCodePoint(parseInt(b[1] === 'x' || b[1] === 'X' ? b.slice(2) : b.slice(1), b[1] === 'x' ? 16 : 10));
  return ENT[b] ?? m;
});

function parseXml(src) {
  const root = { name: '#', attrs: {}, children: [], text: '' };
  const stack = [root];
  let m;
  let last = 0;
  TOKEN.lastIndex = 0;
  while ((m = TOKEN.exec(src)) !== null) {
    const tok = m[0];
    // ★ 标签之间的文本 —— 缺了这一步，`<value>100</value>` 会被读成空串
    if (m.index > last) {
      const seg = src.slice(last, m.index);
      const node = stack[stack.length - 1];
      // ★ `raw` = **未裁剪**原文：字符串期望值的尾随空格是值的一部分
      //   （TCK 1103#008 期望一个空格、1105#007 期望 `"XYZ "`），只留 `text` 会丢。
      node.raw = (node.raw ?? '') + dec(seg);
      const raw = seg.trim();
      if (raw) node.text += dec(raw);
    }
    last = m.index + tok.length;
    if (tok.startsWith('<!--') || tok.startsWith('<?') || tok.startsWith('<!DOCTYPE')) continue;
    if (tok.startsWith('<![CDATA[')) { stack[stack.length - 1].text += tok.slice(9, -3); continue; }
    if (tok.startsWith('</')) { if (stack.length > 1) stack.pop(); continue; }
    let body = tok.slice(1, -1);
    const self = body.endsWith('/');
    if (self) body = body.slice(0, -1);
    const attrs = {};
    for (const a of body.matchAll(/([^\s=/]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) attrs[a[1]] = dec(a[2] ?? a[3] ?? '');
    const node = { name: body.split(/\s/)[0] ?? '', attrs, children: [], text: '' };
    stack[stack.length - 1].children.push(node);
    if (!self) stack.push(node);
  }
  return root;
}

const kids = (n, name) => n.children.filter((c) => c.name === name);
const kid = (n, name) => kids(n, name)[0];

// ---------------------------------------------------------------------------
// expected / input 的 valueType → JS 值
// ---------------------------------------------------------------------------

const NUMERIC = new Set(['decimal', 'double', 'int', 'integer', 'long', 'float', 'short', 'byte', 'nonNegativeInteger']);

/** 把字面量交给 FEEL 自己解析 —— 复用同一套语义，不在运行器里另造一套日期解析 */
function temporal(kind, text) {
  const r = feel.evaluate(`${kind}("${text}")`, {});
  return r.value;
}

function scalarOf(raw, xsiType) {
  const t = (xsiType ?? '').replace(/^xsd:/, '');
  if (NUMERIC.has(t)) return Number(raw);
  if (t === 'boolean') return raw === 'true';
  if (t === 'date') return temporal('date', raw);
  if (t === 'dateTime' || t === 'dateTimeStamp') return temporal('date and time', raw);
  if (t === 'time') return temporal('time', raw);
  if (t === 'duration' || t === 'dayTimeDuration' || t === 'yearMonthDuration') return temporal('duration', raw);
  return raw;
}

/** valueType 节点 → JS 值 */
function valueOf(vt) {
  if (!vt) return null;
  const v = kid(vt, 'value');
  if (v) {
    if (v.attrs['xsi:nil'] === 'true') return null;
    /*
     * ★ 字符串期望值**不能 trim**：尾随空格是值的一部分。
     *   TCK 1103#008 期望 `<value xsi:type="xsd:string"> </value>`（一个空格），
     *   1105#007 期望 `"XYZ "` —— 一律 trim 会把它们压成 `""` / `"XYZ"`。
     *   其余类型（数字 / 布尔 / 时间）走 trim，那是为了吃掉 XML 缩进。
     */
    const t = (v.attrs['xsi:type'] ?? '').replace(/^xsd:/, '');
    const text = t === 'string' ? (v.raw ?? v.text ?? '') : (v.text ?? '');
    return scalarOf(text, v.attrs['xsi:type']);
  }
  const comps = kids(vt, 'component');
  if (comps.length) {
    const out = {};
    for (const c of comps) out[c.attrs.name ?? ''] = valueOf(c);
    return out;
  }
  const list = kid(vt, 'list');
  if (list) {
    if (list.attrs['xsi:nil'] === 'true') return null;
    return kids(list, 'item').map(valueOf);
  }
  return null;
}

// ---------------------------------------------------------------------------
// 比较（★ 无浮点容差）
// ---------------------------------------------------------------------------

function isTemporal(v) {
  return typeof v === 'object' && v !== null && v.__feelTemporal === true;
}

function temporalKey(v) {
  return `${v.kind}|${v.iso ?? ''}|${v.eqKey ?? ''}`;
}

/**
 * ★ 把 FEEL 的**运行时容器**摊成普通 JS 值，比较/打印才谈得上正确。
 *
 * `FeelContext` 是类实例（`{ entries: ReadonlyMap, __feelContext: true }`），
 * 直接 `Object.keys()` 只会拿到 `entries` 与 `__feelContext` 两个内部键 ——
 * 于是 `{a: 1}` 会被判成"两个键的对象"，**所有返回 context 的用例必然误判失败**
 * （0082 / 0057 / 0117 一大片）。摊平必须发生在比较之前，不是打印时。
 */
function normalize(v) {
  if (v === null || v === undefined) return null;
  if (isTemporal(v)) return v;
  if (typeof v === 'object' && v.__feelContext === true) {
    const out = {};
    for (const [k, x] of v.entries) out[k] = normalize(x);
    return out;
  }
  if (Array.isArray(v)) return v.map(normalize);
  if (typeof v === 'object') {
    const out = {};
    for (const [k, x] of Object.entries(v)) out[k] = normalize(x);
    return out;
  }
  return v;
}

/** 一个 number 的十进制有效位数（`toExponential` 天然处理 `5e-7` / `1e21`） */
function significantDigits(n) {
  const s = Math.abs(n).toExponential();
  return s.slice(0, s.indexOf('e')).replace('.', '').replace(/^0+/, '').length || 1;
}

/**
 * ★ 官方口径：decimal 的数字比较**限定精度** —— 绝对差 `< 1e-8`
 *
 * 源码实证（四处同值，均为 `expected.subtract(actual).abs().compareTo(P) < 0`）：
 *  - `runners/dmn-tck-runner-drools/.../CompareValuesUtil.java:11`
 *  - `runners/dmn-tck-runner-camunda/.../CamundaTCKTest.java:68`
 *  - `runners/dmn-tck-runner-camunda-dmn-scala/.../DmnScalaTCKTest.java:71`
 *  - `runners/dmn-tck-runner-quantumdmn/.../FeelValueComparator.java:31`
 *    全部 `NUMBER_COMPARISON_PRECISION = new BigDecimal("0.00000001")`。
 *
 * 官方**明文**口径（issue #609，2023-06-27 已关闭）：非 Java 实现者（dmntk，Rust）
 * 提交了一批"小数点精度"相关补丁，维护者答复：
 *   「decimal 的相等是 **by convention**……参照 drools 源码，把比较限制到第九位小数，
 *     两个 decimal 不必**严格**相等，equal enough 即可。没必要为各家 BigDecimal 实现
 *     在第 30 位的差异追着尾巴跑」—— 并**拒绝修改用例**。
 *
 * ⚠️ 这不是 Q27 反对的东西：Q27 反对的是 dmn-elements 私人脚本里
 *    `max(1e-8, |e|*1e-9)` 那种**随期望值放大**的相对容差；
 *    官方口径是**纯绝对** 1e-8 —— 对 2778 这种量级，比前者**更严**。
 */
const OFFICIAL_NUMBER_PRECISION = 1e-8;
/** 仅供**取证/自检**：`--tolerance 1e-10` 可验证"本包离官方口径还有多少余量"。
 *  门禁口径恒为上面的 `1e-8`（官方值），不因这个参数改变。 */
const NUMBER_PRECISION = Number(arg('tolerance', String(OFFICIAL_NUMBER_PRECISION)));

/**
 * ★ 十进制精度对齐 —— 尊重 TCK 自己声明的序列化精度（**不是**浮点容差）
 *
 * TCK 的期望值按 **decimal 语义**序列化，它给出的**有效位数就是它声明的精度**：
 * 0008 写 `2778.69354943277`（15 位）、0040 写 `2878.6935494327668`（17 位），
 * 而两者是**同一个公式、同一组输入** —— 只是生成者截断到不同位数。
 * 超出该位数的比较没有意义：那几位 TCK 自己就没给。
 *
 * 但对齐**只能消化"位数差异"，消化不了"生成路径差异"** —— TCK 里混着
 * decimal 路径与 double 路径产出的期望值（见 `known-gaps.md` §2.1），两者末位
 * 可差到 1e-11 量级，那正是官方 runner 用 1e-8 兜住的部分。
 */
function sameNumber(a, e) {
  if (Object.is(a, e)) return true;
  if (!Number.isFinite(a) || !Number.isFinite(e)) return false;
  // ① TCK 声明的序列化精度（对齐到它给出的有效位数；差一个末位仍然可能判失败）
  if (Object.is(Number(a.toPrecision(significantDigits(e))), e)) return true;
  // ② 官方 runner 口径：绝对差 < 1e-8（见上方注释，源码 + issue #609 双重依据）
  return Math.abs(a - e) < NUMBER_PRECISION;
}

function valuesEqual(a, b) {
  a = normalize(a);
  b = normalize(b);
  if (a === b) return true;
  if (a === null || b === null || a === undefined || b === undefined) return a == null && b == null;
  if (isTemporal(a) || isTemporal(b)) {
    return isTemporal(a) && isTemporal(b) && temporalKey(a) === temporalKey(b);
  }
  if (typeof a === 'number' || typeof b === 'number') {
    return typeof a === 'number' && typeof b === 'number' && sameNumber(a, b);
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((x, i) => valuesEqual(x, b[i]));
  }
  if (typeof a === 'object' && typeof b === 'object') {
    const ka = Object.keys(a).sort();
    const kb = Object.keys(b).sort();
    if (ka.length !== kb.length || ka.join('\u0000') !== kb.join('\u0000')) return false;
    return ka.every((k) => valuesEqual(a[k], b[k]));
  }
  return false;
}

/**
 * 决策服务**有多个** `outputDecision` 时，它的值是以各输出变量名为键的 context；
 * 此时 `resultNode@name` 指的是"取其中哪一位"。单个输出时值就是那个值，原样返回。
 */
function pickResult(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const m = value.entries instanceof Map ? value.entries : value;
  if (m instanceof Map) return m.has(name) ? m.get(name) : value;
  return Object.prototype.hasOwnProperty.call(m, name) ? m[name] : value;
}

function show(v) {
  v = normalize(v);
  if (v === null || v === undefined) return 'null';
  if (isTemporal(v)) return `${v.kind}(${v.iso})`;
  if (typeof v === 'string') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(show).join(', ')}]`;
  if (typeof v === 'object') return `{${Object.entries(v).map(([k, x]) => `${k}: ${show(x)}`).join(', ')}}`;
  return String(v);
}

// ---------------------------------------------------------------------------
// 跑
// ---------------------------------------------------------------------------

const levels = LEVEL ? [`compliance-level-${LEVEL}`] : ['compliance-level-2', 'compliance-level-3'];
const groups = [];
for (const lv of levels) {
  const dir = join(TCK_DIR, lv);
  if (!existsSync(dir)) continue;
  for (const name of readdirSync(dir).sort()) {
    if (!statSync(join(dir, name)).isDirectory()) continue;
    groups.push({ level: lv, name, dir: join(dir, name) });
  }
}

// ---------------------------------------------------------------------------
// 语料口径统计（NFR-M6：版本与条数**必须实测复算**，不许写死在报告里）
// ---------------------------------------------------------------------------

/** DMN schema 命名空间 → 版本（模型自身 `namespace` 常是 Trisotech 之类的自定义串，
 *  **不能**拿它当版本信号 —— 版本只认 xmlns 声明的 schema 命名空间） */
const DMN_NS_VER = new Map([
  ['https://www.omg.org/spec/DMN/20180521/MODEL/', 'DMN 1.3'],
  ['https://www.omg.org/spec/DMN/20191111/MODEL/', 'DMN 1.4'],
  ['https://www.omg.org/spec/DMN/20230324/MODEL/', 'DMN 1.5'],
  ['https://www.omg.org/spec/DMN/20240513/MODEL/', 'DMN 1.6'],
]);
const nsVer = new Map();
let disabled = 0; // TCK 自己用 <!-- --> 注释掉、已禁用的 testCase（不计分，但要报出来）

function commentRanges(src) {
  const out = [];
  let i = 0;
  for (;;) {
    const s = src.indexOf('<!--', i);
    if (s < 0) break;
    const e = src.indexOf('-->', s + 4);
    if (e < 0) { out.push([s, src.length]); break; }
    out.push([s, e + 3]);
    i = e + 3;
  }
  return out;
}

const results = [];
let total = 0, passed = 0, failed = 0, ignored = 0, errored = 0;
const byLabel = new Map();

for (const g of groups) {
  const files = readdirSync(g.dir);
  const allDmn = files.filter((f) => f.endsWith('.dmn'));
  const testFiles = files.filter((f) => /-test-.*\.xml$/.test(f)).sort();
  if (!allDmn.length || !testFiles.length) continue;

  /*
   * ★ `<import>` 解析（**只有运行器有文件上下文**，库本身没有）：
   *   ① 有 `locationURI` → 相对本模型所在目录读；
   *   ② 没有（TCK 0086 / 0089 就是这种写法）→ 扫同目录 `*.dmn`，按
   *      `definitions@namespace` 匹配。
   *   读进来的模型按命名空间缓存，避免重复解析与循环导入。
   */
  const importCache = new Map();
  const modelCache = new Map();
  const resolveImport = (imp) => {
    const ns = imp.namespace ?? '';
    if (importCache.has(ns)) return importCache.get(ns);
    let found = null;
    const uri = imp.locationURI ?? '';
    if (uri) {
      try {
        found = dmn.readDmn(readFileSync(join(g.dir, uri.replace(/^\.\//, '')), 'utf8')).definitions;
      } catch { found = null; }
    }
    if (!found && ns) {
      for (const f of allDmn) {
        try {
          const d = dmn.readDmn(readFileSync(join(g.dir, f), 'utf8')).definitions;
          if (d && d.namespace === ns) { found = d; break; }
        } catch { /* 读不了的跳过 */ }
      }
    }
    importCache.set(ns, found);
    return found;
  };

  for (const tf of testFiles) {
    const tcSrc = readFileSync(join(g.dir, tf), 'utf8');
    /*
     * ★ 语料里有被 TCK **自己注释掉**的用例（实测 102 条，集中在 0068/0070/0082 等
     *   CL3 组）。它们不是"我们漏跑"，是官方已禁用 —— 不计分，但必须报出来，
     *   否则「语料全量 3569 个 resultNode」与「断言总数 3467」的落差无从解释。
     */
    const cr = commentRanges(tcSrc);
    for (const m of tcSrc.matchAll(/<testCase\b[^>]*>/g)) {
      if (cr.some(([s, e]) => m.index >= s && m.index < e)) disabled += 1;
    }
    const tcRoot = kid(parseXml(tcSrc), 'testCases');
    if (!tcRoot) continue;
    const labels = kids(kid(tcRoot, 'labels') ?? tcRoot, 'label').map((l) => l.text ?? '');
    if (LABEL_FILTER && !labels.some((l) => l.includes(LABEL_FILTER)) && !g.name.includes(LABEL_FILTER)) continue;

    /*
     * ★ 模型必须**按测试文件**加载，不能按目录取第一个 `.dmn`：
     *   TCK 一个目录里常放好几个模型（1160 有 A/B/C，0089 有主模型 + Model_B + Model_B2），
     *   用哪个由该测试文件自己的 `<modelName>` 指定。取"第一个"会加载错模型 ——
     *   1160 那 4 条一直报 `DMN_EVAL_NO_DECISION`（加载的是 A，里面没有 DecisionB）。
     */
    const modelName = (kid(tcRoot, 'modelName')?.text ?? '').trim();
    const dmnFile = allDmn.includes(modelName) ? modelName : allDmn[0];
    let model;
    let index;
    try {
      if (!modelCache.has(dmnFile)) {
        const mSrc = readFileSync(join(g.dir, dmnFile), 'utf8');
        for (const m of mSrc.matchAll(/xmlns(?::[\w.-]+)?\s*=\s*"([^"]*)"/g)) {
          const v = DMN_NS_VER.get(m[1]);
          if (v) nsVer.set(v, (nsVer.get(v) ?? 0) + 1);
        }
        modelCache.set(dmnFile, {
          def: dmn.readDmn(mSrc).definitions,
          idx: null,
        });
      }
      const slot = modelCache.get(dmnFile);
      if (slot.idx === null) slot.idx = dmn.indexModel(slot.def, { resolveImport });
      model = slot.def;
      index = slot.idx;
    } catch (e) {
      // 模型本身读不了（1.6 专有特性 / 未知命名空间）→ 该文件整份记为 error
      for (const _ of kids(tcRoot, 'testCase')) {
        total += 1; errored += 1;
        results.push({ group: g.name, level: g.level, status: 'error', reason: `模型读入失败: ${e.code ?? e.message}` });
      }
      continue;
    }

    for (const tc of kids(tcRoot, 'testCase')) {
      const tcId = tc.attrs.id ?? '';
      const input = {};
      for (const node of kids(tc, 'inputNode')) {
        input[node.attrs.name ?? ''] = valueOf(node);
      }
      for (const node of kids(tc, 'resultNode')) {
        total += 1;
        const name = node.attrs.name ?? '';
        const isErrorResult = node.attrs.errorResult === 'true';
        /** ★ IGNORED 的**唯一**口径：TCK 需要真实 Java 类的那组（0076）。
         *  其余 `errorResult="true"` 是「期望错误/未知结果」的**正常用例**，必须判过。 */
        const isExternalJava = labels.some((l) => /External Java/i.test(l));
        const key = `${g.name}/${tf}#${tcId}/${name}`;
        const labelKey = labels[labels.length - 1] ?? g.name;
        const bump = (ok) => {
          const rec = byLabel.get(labelKey) ?? { total: 0, passed: 0, ignored: 0 };
          rec.total += 1;
          if (ok === 'pass') rec.passed += 1;
          if (ok === 'ignored') rec.ignored += 1;
          byLabel.set(labelKey, rec);
        };

        if (isExternalJava) {
          ignored += 1; bump('ignored');
          results.push({ group: g.name, key, status: 'ignored', reason: 'TCK 需要真实 Java 类（external-java），非 FEEL 缺陷' });
          continue;
        }
        const expected = valueOf(kid(node, 'expected'));
        let actual;
        let thrown = null;
        try {
          /*
           * ★ `testCase@invocableName` 才是**被调对象**（TCK 用它指名要 invoked 的
           *   决策服务 / BKM），`resultNode@name` 只是"取结果的哪一位"。
           *   忽略它就会退化成"独立求值那个输出决策" —— 决策服务的入参语义随之消失
           *   （TCK 0085#002_a 期望"没给入参 → null"，独立求值却会自己算出 "foo bar"）。
           */
          const invocable = tc.attrs.invocableName ?? '';
          const r = dmn.evaluateDecision(model, invocable || name, input, { index });
          actual = pickResult(r.value, name);
        } catch (e) {
          thrown = e;
        }
        // ★ `errorResult="true"` = TCK 期望一个**错误结果**（期望值恒为 null）。
        //    FEEL 的正统表达是 null（未知），抛错同样是"产生了错误"—— 两者都算通过；
        //    反过来，**给了具体值才是真的错**（把不该算出来的算出来了）。
        if (isErrorResult) {
          const ok = thrown !== null || actual === null || actual === undefined;
          if (ok) {
            passed += 1; bump('pass');
            results.push({ group: g.name, key, status: 'pass' });
          } else {
            failed += 1; bump('fail');
            results.push({ group: g.name, key, status: 'fail', expected: 'null（errorResult）', actual: show(actual) });
          }
          continue;
        }
        if (thrown) {
          failed += 1; bump('fail');
          results.push({ group: g.name, key, status: 'fail', expected: show(expected), actual: `THROW ${thrown.code ?? thrown.name}: ${thrown.message}` });
          continue;
        }
        if (valuesEqual(actual, expected)) {
          passed += 1; bump('pass');
          results.push({ group: g.name, key, status: 'pass' });
        } else {
          failed += 1; bump('fail');
          results.push({ group: g.name, key, status: 'fail', expected: show(expected), actual: show(actual) });
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// 报告
// ---------------------------------------------------------------------------

const scored = total - ignored;
const pct = scored ? ((passed / scored) * 100).toFixed(1) : '0.0';
const verStr = nsVer.size
  ? [...nsVer.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}×${v}`).join(', ')
  : '(未检出 DMN xmlns)';
/** 判据① 的原料：按 label 的通过情况（判据② 是断言总分；两条都要可观测） */
const labelRows = [...byLabel.entries()]
  .map(([k, r]) => ({ label: k, total: r.total, passed: r.passed, ignored: r.ignored }))
  .sort((a, b) => (a.passed - a.ignored) / a.total - (b.passed - b.ignored) / b.total || b.total - a.total);

if (AS_JSON) {
  console.log(JSON.stringify({
    total, passed, failed, ignored, errored, scored, pct: Number(pct),
    disabled, versions: [...nsVer.entries()].sort((a, b) => b[1] - a[1]),
    labels: labelRows,
    failures: results.filter((r) => r.status !== 'pass'),
  }, null, 1));
  process.exit(0);
}

console.log('=== floken-dmn · DMN TCK（A 口径：完整 DRG）===');
console.log(`语料：${TCK_DIR}`);
console.log(`语料版本：${verStr}（按模型 xmlns **实测**，${[...nsVer.values()].reduce((s, v) => s + v, 0)} 份模型）  获取日期：${new Date().toISOString().slice(0, 10)}`);
console.log('');
console.log(`断言总数 ${total}  通过 ${passed}  失败 ${failed}  IGNORED ${ignored}${errored ? `  模型错误 ${errored}` : ''}`);
console.log(`计分口径（扣 IGNORED）: ${passed}/${scored} (${pct}%)`);
console.log(`语料全量 ${total + disabled} = 生效 ${total} + 官方已注释禁用 ${disabled}（禁用不计分）`);
console.log('');

const failList = results.filter((r) => r.status === 'fail');
const errList = results.filter((r) => r.status === 'error');
if (VERBOSE || !failList.length) {
  const n = LIMIT || 40;
  for (const r of failList.slice(0, n)) {
    console.log(`  ✗ ${r.key}`);
    console.log(`      期望 ${r.expected}`);
    console.log(`      实际 ${r.actual}`);
  }
  if (failList.length > n) console.log(`  … 另有 ${failList.length - n} 条`);
} else {
  const byGroup = new Map();
  for (const r of failList) byGroup.set(r.group, (byGroup.get(r.group) ?? 0) + 1);
  const top = [...byGroup.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20);
  console.log(`失败最多的组（共 ${failList.length} 条）：`);
  for (const [g, n] of top) console.log(`  ${String(n).padStart(4)}  ${g}`);
  console.log('\n加 --verbose 看逐条详情，--label <关键字> 只看某组。');
}
if (errList.length) {
  console.log(`\n模型读入失败 ${errList.length} 条：${[...new Set(errList.map((r) => r.reason))].slice(0, 5).join(' | ')}`);
}
console.log('');
console.log(`IGNORED 口径：仅 label 含 "External Java" 的 0076 组（需真实 Java 类）。`);
console.log(`★ errorResult="true" **不豁免**：TCK 用它表示「期望错误/未知结果」，实际给 null 或抛错都判通过。`);

/*
 * ★ 判据① 的观测面（此前 `byLabel` 算了却从不打印 —— 等于第二把尺子形同虚设）。
 *   判据② 是断言总分（上面那行）；判据① 是「按官方 label 不退化」，两者都要看得见。
 *   基线文件尚未固化（是否把 label 零退化设为 A 口径硬闸门，待定），此处先让数据可观测。
 */
const worst = labelRows.filter((r) => r.passed + r.ignored < r.total).slice(0, 15);
console.log('');
console.log(`按 label 统计（共 ${labelRows.length} 个；判据① 原料）：`);
for (const r of worst) {
  const ok = r.passed + r.ignored;
  console.log(`  ${String(r.total - ok).padStart(3)}/${String(r.total).padStart(3)} 未过   ${r.label}`);
}
if (!worst.length) console.log('  （全部 label 满分）');
