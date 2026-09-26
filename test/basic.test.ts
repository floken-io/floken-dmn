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

describe('floken-dmn 元模型规模（文档口径自证）', () => {
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

describe('DRG 求值（委托 floken-feel）', () => {
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
