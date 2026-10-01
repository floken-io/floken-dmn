import { describe, it, expect } from 'vitest';
import { createDecisionHandler, createDecisionHandlerFrom, readDmn } from '../src/index.js';
import type { Diagnostic } from '../src/index.js';

const NS = 'https://www.omg.org/spec/DMN/20230324/MODEL/';

/**
 * 最小 DMN 1.5 决策表（住宿标准）。
 *
 * ⚠️ **`typeRef` 是故意不写全的**：决策的 `<variable>` 一旦声明 `typeRef="string"`，
 * 而决策表是**多列**输出（结果是对象），`coerceTypeRef` 会把结果**静默压成 null**
 * （且不带任何诊断 —— 已登记为 dmn 侧的静默降级缺陷，见本轮末的说明）。
 * 故多列夹具不声明决策变量类型，单列夹具才声明。
 */
function xmlOf(opts: { cols?: 1 | 2; varType?: string } = {}): string {
  const cols = opts.cols ?? 1;
  const outputs =
    cols === 2
      ? `<output id="dt_out_1" typeRef="string" name="level"/>
      <output id="dt_out_2" typeRef="number" name="quota"/>`
      : `<output id="dt_out_1" typeRef="string" name="level"/>`;
  const extra1 = cols === 2 ? `\n        <outputEntry id="r1_o2"><text>300</text></outputEntry>` : '';
  const extra2 = cols === 2 ? `\n        <outputEntry id="r2_o2"><text>800</text></outputEntry>` : '';
  const tr = opts.varType ? ` typeRef="${opts.varType}"` : '';
  return `<?xml version="1.0" encoding="UTF-8"?>
<definitions xmlns="${NS}" id="def_1" name="住宿" namespace="urn:test">
  <inputData id="in_amount" name="amount">
    <variable id="v_amount" name="amount" typeRef="number"/>
  </inputData>
  <decision id="dec_1" name="住宿标准">
    <variable id="v_out" name="标准"${tr}/>
    <informationRequirement><requiredInput href="#in_amount"/></informationRequirement>
    <decisionTable id="dt_1" hitPolicy="UNIQUE">
      <input id="dt_in_1">
        <inputExpression id="dt_ie_1" typeRef="number"><text>amount</text></inputExpression>
      </input>
      ${outputs}
      <rule id="r_1">
        <inputEntry id="r1_i"><text>&lt; 5000</text></inputEntry>
        <outputEntry id="r1_o"><text>"经济"</text></outputEntry>${extra1}
      </rule>
      <rule id="r_2">
        <inputEntry id="r2_i"><text>&gt;= 5000</text></inputEntry>
        <outputEntry id="r2_o"><text>"商务"</text></outputEntry>${extra2}
      </rule>
    </decisionTable>
  </decision>
</definitions>`;
}

const ctx = (nodeId = 'BRT_1') => ({
  instanceId: 'inst_1',
  nodeId,
  input: { amount: 8600 } as Readonly<Record<string, unknown>>,
});

describe('createDecisionHandler · 契约形状', () => {
  it('★ 与引擎 `DecisionHandler` 同形：`evaluate(input, ctx)` → Promise<Record>', async () => {
    const h = createDecisionHandler(xmlOf({ varType: 'string' }));
    expect(typeof h.evaluate).toBe('function');
    expect(h.evaluate).toHaveLength(2);

    const out = await h.evaluate({ amount: 8600 }, ctx());
    expect(out).not.toBeNull();
    expect(typeof out).toBe('object');
    expect(Array.isArray(out)).toBe(false); // 引擎 `assertVariablePatch` 会拒数组
  });

});

describe('createDecisionHandler · 结果落点', () => {
  it("默认 'merge'：单列标量挂到**决策变量名**下", async () => {
    const h = createDecisionHandler(xmlOf({ varType: 'string' }));
    expect(await h.evaluate({ amount: 8600 }, ctx())).toEqual({ 标准: '商务' });
    expect(await h.evaluate({ amount: 100 }, ctx())).toEqual({ 标准: '经济' });
  });

  it("默认 'merge'：多列对象逐键并入", async () => {
    const h = createDecisionHandler(xmlOf({ cols: 2 }));
    expect(await h.evaluate({ amount: 8600 }, ctx())).toEqual({ level: '商务', quota: 800 });
    expect(await h.evaluate({ amount: 100 }, ctx())).toEqual({ level: '经济', quota: 300 });
  });

  it("'node'：整个结果挂到 `ctx.nodeId` 下（与 scriptTask 的 D-59 落点对齐）", async () => {
    const h = createDecisionHandler(xmlOf({ cols: 2 }), { as: 'node' });
    expect(await h.evaluate({ amount: 8600 }, ctx('BRT_9'))).toEqual({
      BRT_9: { level: '商务', quota: 800 },
    });
  });

  it('自定义 `as`：宿主完全接管落点', async () => {
    const h = createDecisionHandler(xmlOf({ cols: 2 }), {
      as: (result) => ({ picked: (result.value as Record<string, unknown>)['quota'] }),
    });
    expect(await h.evaluate({ amount: 8600 }, ctx())).toEqual({ picked: 800 });
  });
});

describe('createDecisionHandler · 决策定位', () => {
  it('不指定且唯一 → 自动取它', async () => {
    const h = createDecisionHandler(xmlOf({ varType: 'string' }));
    expect(await h.evaluate({ amount: 8600 }, ctx())).toEqual({ 标准: '商务' });
  });

  it('按 id / 元素名 / 变量名都能定位', async () => {
    for (const key of ['dec_1', '住宿标准', '标准']) {
      const h = createDecisionHandler(xmlOf({ varType: 'string' }), { decision: key });
      expect(await h.evaluate({ amount: 8600 }, ctx()), key).toEqual({ 标准: '商务' });
    }
  });

  it('`decision` 传函数 → 按 ctx 决定（一个流程多张表）', async () => {
    const h = createDecisionHandler(xmlOf({ varType: 'string' }), {
      decision: (c) => (c.nodeId === 'BRT_1' ? 'dec_1' : ''),
    });
    expect(await h.evaluate({ amount: 8600 }, ctx('BRT_1'))).toEqual({ 标准: '商务' });
    await expect(h.evaluate({ amount: 8600 }, ctx('BRT_2'))).rejects.toMatchObject({
      code: 'DMN_EVAL_NO_DECISION',
    });
  });

  it('★ 多决策模型不指定入口 → 抛 `DMN_EVAL_NO_DECISION`（不猜）', async () => {
    const two = xmlOf({ varType: 'string' }).replace(
      '</definitions>',
      `<decision id="dec_2" name="第二条">
        <variable id="v_out2" name="标准2" typeRef="string"/>
        <literalExpression id="le_2"><text>"x"</text></literalExpression>
      </decision>
</definitions>`,
    );
    const h = createDecisionHandler(two);
    await expect(h.evaluate({ amount: 8600 }, ctx())).rejects.toMatchObject({
      code: 'DMN_EVAL_NO_DECISION',
    });
    // 显式指定仍然可用
    const ok = createDecisionHandler(two, { decision: 'dec_1' });
    expect(await ok.evaluate({ amount: 8600 }, ctx())).toEqual({ 标准: '商务' });
  });
});

describe('createDecisionHandler · 诊断出口', () => {
  it('不传 `onDiagnostics`：诊断不落地，但求值照常', async () => {
    const h = createDecisionHandler(xmlOf({ varType: 'string' }));
    expect(await h.evaluate({ amount: 8600 }, ctx())).toEqual({ 标准: '商务' });
  });

  it('传了 → 拿到同一批诊断对象', async () => {
    const seen: Diagnostic[][] = [];
    const h = createDecisionHandler(xmlOf({ varType: 'string' }), {
      onDiagnostics: (d) => void seen.push([...d]),
    });
    await h.evaluate({ amount: 8600 }, ctx());
    // 本夹具无诊断 ⇒ 不该凭空调回调（"没诊断"不等于"要报一条空诊断"）
    expect(seen).toHaveLength(0);
  });
});

describe('createDecisionHandlerFrom', () => {
  it('从已解析的 definitions 建（宿主自己管 XML）', async () => {
    const { definitions } = readDmn(xmlOf({ varType: 'string' }));
    const h = createDecisionHandlerFrom(definitions, { decision: 'dec_1' });
    expect(await h.evaluate({ amount: 100 }, ctx())).toEqual({ 标准: '经济' });
  });
});
