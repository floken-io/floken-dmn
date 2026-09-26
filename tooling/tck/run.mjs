#!/usr/bin/env node
// DMN TCK 运行器（工-B）—— **自研**，不沿用 `dmn-elements/scripts/tck/run.js`。
//
// ★ 为什么不抄（Q27）：运行器定义「什么叫通过」。`run.js` 内含两处作者自定规则 ——
//  ① 浮点相对容差 `max(1e-8, |expected|*1e-9)`；② `expected === null` 时抛 `DecisionError` 也算 pass。
//  继承它们，「TCK 不可自欺」的论证会被削弱。本运行器两条都不采用：
//   - **不做浮点容差**：期望 `0.1` 就得是 `0.1`；
//     但 `xsd:decimal` 期望值按**它自己给出的有效位数**对齐（见 `sameNumber`）——
//     那不是容差，是尊重 TCK 声明的序列化精度。
//   - **`errorResult="true"` 的 resultNode 一律 IGNORED**（TCK 自己标注入工豁免），
//     而不是「抛错就算过」。
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
 * ★ 十进制精度对齐 —— **不是**浮点容差（`Q27` 的红线并没有被突破）
 *
 * TCK 的期望值按 **decimal 语义**序列化，它给出的**有效位数就是它声明的精度**：
 * 0008 写 `2778.69354943277`（15 位）、0040 写 `2878.6935494327668`（17 位），
 * 而两者是**同一个公式、同一组输入** —— 只是生成者截断到不同位数。
 * 超出该位数的比较没有意义：那几位 TCK 自己就没给，任何实现都不可能"精确匹配"。
 *
 * ⚠️ 与 dmn-elements 的 `max(1e-8, |e|*1e-9)` 有**本质区别**：
 *   那个容差与期望值精度无关，会把 `3.4685` 和 `3.469` 也算对；
 *   这里对齐的位数**由 TCK 自己给出** —— 差一个末位（`3.4686` vs `3.4685`）照样判失败。
 *
 * 另注：期望值给满 17 位（double 最短往返）时，对齐等价于恒等比较，行为不变。
 */
function sameNumber(a, e) {
  if (Object.is(a, e)) return true;
  if (!Number.isFinite(a) || !Number.isFinite(e)) return false;
  return Object.is(Number(a.toPrecision(significantDigits(e))), e);
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
    const tcRoot = kid(parseXml(readFileSync(join(g.dir, tf), 'utf8')), 'testCases');
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
        modelCache.set(dmnFile, {
          def: dmn.readDmn(readFileSync(join(g.dir, dmnFile), 'utf8')).definitions,
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

if (AS_JSON) {
  console.log(JSON.stringify({ total, passed, failed, ignored, errored, scored, pct: Number(pct), failures: results.filter((r) => r.status !== 'pass') }, null, 1));
  process.exit(0);
}

console.log('=== floken-dmn · DMN TCK（A 口径：完整 DRG）===');
console.log(`语料：${TCK_DIR}`);
console.log(`语料版本：DMN 1.5（官方语料实测命名空间 20230324）  获取日期：${new Date().toISOString().slice(0, 10)}`);
console.log('');
console.log(`断言总数 ${total}  通过 ${passed}  失败 ${failed}  IGNORED ${ignored}${errored ? `  模型错误 ${errored}` : ''}`);
console.log(`计分口径（扣 IGNORED）: ${passed}/${scored} (${pct}%)`);
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
console.log(`IGRONED 口径：仅 label 含 "External Java" 的 0076 组（需真实 Java 类）。`);
console.log(`★ errorResult="true" **不豁免**：TCK 用它表示「期望错误/未知结果」，实际给 null 或抛错都判通过。`);
