import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { decide, decideOnly, readDmn, indexModel, resultName, writeDmn, parseXml } from '../src/index.js';
import { SPEC_STATS, descendantsOf } from '../src/index.js';

/** 官方语料目录。**不随包分发**（NFR-M2 / §4.3：CC BY-SA 有传染性），缺源时跳过。 */
const TCK = join(process.cwd(), '..', '..', '.workbuddy', '_bpmn-sandbox', 'tck', 'raw', 'TestCases');
const CL2 = join(TCK, 'compliance-level-2', '0100-feel-constants', '0100-feel-constants.dmn');
const CL3 = join(TCK, 'compliance-level-2', '0105-feel-math', '0105-feel-math.dmn');
const hasTck = existsSync(TCK);

describe('@floken-io/dmn 元模型规模（文档口径自证）', () => {
  it('DMN 1.5 = 55 类型 / 121+ 自有属性', () => {
    expect(SPEC_STATS.dmnTypes).toBe(55);
    expect(SPEC_STATS.dmnOwnProperties).toBeGreaterThanOrEqual(121);
  });

  it('Expression 的后代包含 1.4 新增的盒装表达式', () => {
    const kids = descendantsOf('Expression').map((s) => s.replace('dmn:', ''));
    for (const n of ['LiteralExpression', 'DecisionTable', 'Context', 'List', 'Relation', 'Conditional', 'Filter', 'For', 'Some', 'Every']) {
      expect(kids, `缺 ${n}`).toContain(n);
    }
  });
});

describe('自研 XML 解析（Q38）', () => {
  it('命名空间 + 属性 + 文本', () => {
    const n = parseXml('<a xmlns="urn:x" xmlns:p="urn:p"><b p:k="1">t</b><!-- c --></a>');
    expect(n.localName).toBe('a');
    expect(n.ns).toBe('urn:x');
    expect(n.children[0]?.localName).toBe('b');
    expect(n.children[0]?.attrs['p:k']).toBe('1');
    expect(n.children[0]?.text).toBe('t');
  });

  it('CDATA 不转义、实体展开', () => {
    const n = parseXml('<a><![CDATA[<b>&amp;]]></a>');
    expect(n.text).toBe('<b>&amp;');
    expect(parseXml('<a>&lt;&amp;&#65;</a>').text).toBe('<&A');
  });

  it('★ 拒绝外部实体（XXE）', () => {
    expect(() => parseXml('<!DOCTYPE a SYSTEM "file:///etc/passwd"><a/>')).toThrowError(expect.objectContaining({ code: 'DMN_XML_EXTERNAL_ENTITY' }));
    expect(() => parseXml('<a>&custom;</a>')).toThrowError(expect.objectContaining({ code: 'DMN_XML_EXTERNAL_ENTITY' }));
  });

  it('不闭合 / 标签不匹配要抛，并给定位', () => {
    expect(() => parseXml('<a><b></a>')).toThrowError(expect.objectContaining({ code: 'DMN_XML_MALFORMED' }));
    expect(() => parseXml('<a>')).toThrowError(expect.objectContaining({ code: 'DMN_XML_UNCLOSED' }));
  });
});

describe('读写往返', () => {
  it('1.5 读入 → 导出恒写 1.5 命名空间', () => {
    if (!hasTck) return;
    const xml = readFileSync(CL2, 'utf8');
    const { definitions, version, diagnostics } = readDmn(xml);
    expect(version).toBe('1.5');
    expect(definitions.$type).toBe('Definitions');
    const out = writeDmn(definitions);
    expect(out).toContain('https://www.omg.org/spec/DMN/20230324/MODEL/');
    // 回读不出错、结构不丢
    const again = readDmn(out);
    expect(indexModel(again.definitions).decisions.length).toBe(indexModel(definitions).decisions.length);
    expect(diagnostics.length).toBeGreaterThanOrEqual(0);
  });
});

describe('DRG 求值（委托 @floken-io/feel）', () => {
  it('literal expression：CL2 0100', () => {
    if (!hasTck) return;
    const xml = readFileSync(CL2, 'utf8');
    const r1 = decide(xml, 'Decision1');
    expect(r1.value).toBe(true);
    const r2 = decide(xml, 'Decision2');
    expect(r2.value).toBe(false);
  });

  it('算术表达式：CL3 0105', () => {
    if (!hasTck) return;
    const xml = readFileSync(CL3, 'utf8');
    expect(decide(xml, 'Decision1').value).toBe(15);
    expect(decide(xml, 'Decision2').value).toBe(-15);
    expect(decide(xml, 'Decision4').value).toBe(5);
  });

  it('决策表名 + 变量名都能当入口', () => {
    if (!hasTck) return;
    const xml = readFileSync(CL2, 'utf8');
    const idx = indexModel(readDmn(xml).definitions);
    const names = idx.decisions.map(resultName);
    expect(names).toContain('Decision1');
    expect(decide(xml, 'Decision1', {}, { index: idx }).value).toBe(true);
  });

  it('★ 入口不存在要抛，不静默给 null', () => {
    if (!hasTck) return;
    expect(() => decide(readFileSync(CL2, 'utf8'), 'NoSuchDecision')).toThrowError(expect.objectContaining({ code: 'DMN_EVAL_NO_DECISION' }));
  });

  it('模型里决策数 ≠ 1 时 decideOnly 拒绝推断', () => {
    if (!hasTck) return;
    expect(() => decideOnly(readFileSync(CL2, 'utf8'))).toThrow(/决策数不等于 1/);
  });
});

describe('命名空间双向兼容（Q35）', () => {
  it('1.3 / 1.4 / 1.5 / 1.6 都能读入', () => {
    const mk = (ns: string) =>
      `<definitions xmlns="${ns}" name="d" id="d1"><decision name="D" id="_d"><literalExpression><text>1+1</text></literalExpression></decision></definitions>`;
    expect(readDmn(mk('https://www.omg.org/spec/DMN/20191111/MODEL/')).version).toBe('1.3');
    expect(readDmn(mk('https://www.omg.org/spec/DMN/20211108/MODEL/')).version).toBe('1.4');
    expect(readDmn(mk('https://www.omg.org/spec/DMN/20230324/MODEL/')).version).toBe('1.5');
    expect(readDmn(mk('https://www.omg.org/spec/DMN/20240513/MODEL/')).version).toBe('1.6');
  });

  it('未知命名空间 → 抛', () => {
    expect(() => readDmn('<definitions xmlns="urn:nope" name="d" id="d1"/>')).toThrowError(expect.objectContaining({ code: 'DMN_MODEL_UNKNOWN_VERSION' }));
  });

  it('★ 1.6 专有特性必须报错，不静默降级', () => {
    const ns = 'https://www.omg.org/spec/DMN/20240513/MODEL/';
    const onnx = `<definitions xmlns="${ns}" name="d" id="d1"><import importType="ONNX"/></definitions>`;
    expect(() => readDmn(onnx)).toThrowError(expect.objectContaining({ code: 'DMN_MODEL_UNSUPPORTED_FEATURE' }));
    const bfeel = `<definitions xmlns="${ns}" name="d" id="d1" expressionLanguage="https://www.omg.org/spec/DMN/20240513/B-FEEL/"><decision name="D" id="_d"><literalExpression><text>1</text></literalExpression></decision></definitions>`;
    expect(() => readDmn(bfeel)).toThrowError(expect.objectContaining({ code: 'DMN_MODEL_UNSUPPORTED_FEATURE' }));
  });
});

describe('errorMode 透传（★ 默认不变：null + 诊断；可选 fail-fast）', () => {
  const ns = 'https://www.omg.org/spec/DMN/20230324/MODEL/';
  /** 单决策 literalExpression 模型 */
  const lit = (text: string) =>
    `<definitions xmlns="${ns}" id="d1" name="d"><decision id="dec" name="dec">` +
    `<literalExpression><text>${text}</text></literalExpression></decision></definitions>`;
  /** 单规则决策表：输入 x，输入条目里故意用**类型不符**的调用 */
  const table = (entry: string) =>
    `<definitions xmlns="${ns}" id="d1" name="d"><decision id="dec" name="dec"><decisionTable id="dt">` +
    `<input id="i1"><inputExpression id="ie1" typeRef="number"><text>x</text></inputExpression></input>` +
    `<output id="o1"/><rule id="r1"><inputEntry id="e1"><text>${entry}</text></inputEntry>` +
    `<outputEntry id="oe1"><text>"hit"</text></outputEntry></rule></decisionTable></decision></definitions>`;

  it('① 默认：未知 → null + 带定位的诊断（设计器校验走这条）', () => {
    const r = decide(lit('MissingVar'), 'dec');
    expect(r.value).toBeNull();
    const d = r.diagnostics.find((x) => x.code === 'FEEL_EVAL_NO_VARIABLE');
    expect(d).toBeDefined();
    expect(d?.start).toBe(0);
    expect(d?.end).toBe(10); // 'MissingVar'.length
    expect(d?.message).toContain('MissingVar');
  });

  it('② 默认：类型不符 → null + ARG_TYPE 诊断，不抛', () => {
    const r = decide(lit('substring(1, 2)'), 'dec');
    expect(r.value).toBeNull();
    expect(r.diagnostics.map((d) => d.code)).toContain('FEEL_EVAL_ARG_TYPE');
  });

  it('③ errorMode:"throw"：类型不符 → 抛 DMN_EVAL_FEEL（fail-fast）', () => {
    expect(() => decide(lit('substring(1, 2)'), 'dec', {}, { errorMode: 'throw' })).toThrowError(
      expect.objectContaining({ code: 'DMN_EVAL_FEEL' }),
    );
  });

  it('④ 抛出的异常保留 feel 的 cause（不吞，NFR-M4）', () => {
    let caught: any;
    try {
      decide(lit('substring(1, 2)'), 'dec', {}, { errorMode: 'throw' });
    } catch (e) {
      caught = e;
    }
    expect(caught?.code).toBe('DMN_EVAL_FEEL');
    expect(caught?.details?.expression).toBe('substring(1, 2)');
    expect(caught?.cause?.code).toBe('FEEL_EVAL_ARG_TYPE');
  });

  it('⑤ 显式 "null" 与默认完全同形', () => {
    expect(decide(lit('substring(1, 2)'), 'dec', {}, { errorMode: 'null' })).toEqual(decide(lit('substring(1, 2)'), 'dec'));
  });

  it('⑥ 开关对决策表的 unary tests 同样生效', () => {
    expect(decide(table('= substring(1, 2)'), 'dec', { x: 5 }).value).toBeNull();
    expect(() => decide(table('= substring(1, 2)'), 'dec', { x: 5 }, { errorMode: 'throw' })).toThrowError(
      expect.objectContaining({ code: 'DMN_EVAL_FEEL' }),
    );
  });

  it('⑦ ★ 为什么默认必须是 "null"：filter 内的局部 unknown 不能打掉整条', () => {
    // filter 对每项求值，某一项类型不符 → 该项 unknown（不命中），**整条表达式仍要出结果**。
    // 这正是 TCK 0006-join#001 在 errorMode:'throw' 下失败的原因（抛 ARG_TYPE，拿不到 "Smith"）。
    const src = '[1,2,3][item = substring(1, 2)][1]';
    expect(decide(lit(src), 'dec').value).toBeNull(); // 默认：不命中 → null（不抛）
    expect(() => decide(lit(src), 'dec', {}, { errorMode: 'throw' })).toThrowError(
      expect.objectContaining({ code: 'DMN_EVAL_FEEL' }),
    );
  });

  it('⑧ 正常表达式不受开关影响（throw 下也不误报）', () => {
    expect(decide(lit('1 + 1'), 'dec', {}, { errorMode: 'throw' }).value).toBe(2);
    expect(decide(table('&gt; 3'), 'dec', { x: 5 }, { errorMode: 'throw' }).value).toBe('hit');
  });
});
