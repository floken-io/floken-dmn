/**
 * ★ **端到端**：真 `@floken-io/engine` 跑 `businessRuleTask`，决策由真 `@floken-io/dmn` 出。
 *
 * 这是 `04` §11 **DMN-D4** / 立项书 §6 **M4 判据①** 要求的那条用例：
 * 「`BusinessRuleTask` 经 `decisionHandler` 调自研 DMN」。
 * `test/bridge.test.ts` 验的是**适配器自身**，本文件验的是**两个包接上之后真的能跑**。
 *
 * ⚠️ `@floken-io/engine` 只作 **devDependency**（与 `feel` 拿 `lezer-feel` 作 TCK 对照
 * 的先例同款）—— 依赖方向铁律（`AGENTS.md` §2）约束的是**运行时**依赖，
 * dmn 的 `dependencies` 仍然只有 `@floken-io/feel`：「不装 dmn，引擎一样完整」不能被破坏。
 */
import { describe, it, expect } from 'vitest';
import { createEngine, createMemoryStore } from '@floken-io/engine';
import type { ProcessDefinition } from '@floken-io/moddle';
import { createDecisionHandler } from '../src/index.js';

const NS = 'https://www.omg.org/spec/DMN/20230324/MODEL/';

/** 单列决策表：amount >= 5000 → "商务"，否则 "经济"；结果挂在决策变量名 `level` 下 */
const DMN = `<?xml version="1.0" encoding="UTF-8"?>
<definitions xmlns="${NS}" id="def_1" name="住宿" namespace="urn:test">
  <inputData id="in_amount" name="amount">
    <variable id="v_amount" name="amount" typeRef="number"/>
  </inputData>
  <decision id="dec_1" name="住宿标准">
    <variable id="v_out" name="level" typeRef="string"/>
    <informationRequirement><requiredInput href="#in_amount"/></informationRequirement>
    <decisionTable id="dt_1" hitPolicy="UNIQUE">
      <input id="dt_in_1">
        <inputExpression id="dt_ie_1" typeRef="number"><text>amount</text></inputExpression>
      </input>
      <output id="dt_out_1" typeRef="string" name="level"/>
      <rule id="r_1">
        <inputEntry id="r1_i"><text>&lt; 5000</text></inputEntry>
        <outputEntry id="r1_o"><text>"经济"</text></outputEntry>
      </rule>
      <rule id="r_2">
        <inputEntry id="r2_i"><text>&gt;= 5000</text></inputEntry>
        <outputEntry id="r2_o"><text>"商务"</text></outputEntry>
      </rule>
    </decisionTable>
  </decision>
</definitions>`;

const approval = (who: string) => ({
  'floken:approval': { approvers: [{ type: 'user', value: who }] },
});

/** Start → BRT_1（决策）→ G_1（按决策结果分支）→ Task_big / Task_small → End */
const def = {
  schemaVersion: '1.0.0',
  id: 'Definitions_1',
  processes: [
    {
      id: 'Process_1',
      nodes: [
        { id: 'Start_1', type: 'startEvent' },
        { id: 'BRT_1', type: 'businessRuleTask' },
        { id: 'G_1', type: 'exclusiveGateway' },
        { id: 'Task_big', type: 'userTask', extension: approval('u_boss') },
        { id: 'Task_small', type: 'userTask', extension: approval('u_lead') },
        { id: 'End_1', type: 'endEvent' },
      ] as never,
      flows: [
        { id: 'f1', from: 'Start_1', to: 'BRT_1' },
        { id: 'f2', from: 'BRT_1', to: 'G_1' },
        { id: 'f3', from: 'G_1', to: 'Task_big', condition: 'level = "商务"' },
        { id: 'f4', from: 'G_1', to: 'Task_small', condition: 'level = "经济"' },
        { id: 'f5', from: 'Task_big', to: 'End_1' },
        { id: 'f6', from: 'Task_small', to: 'End_1' },
      ] as never,
    },
  ],
} as unknown as ProcessDefinition;

/**
 * `as:'node'` 用的流程：**不带网关**。
 *
 * ⚠️ 为什么不能复用上面那条带网关的流程：`as:'node'` 把结果落在 `BRT_1` 变量下，
 *   而网关条件写的是 `level = "商务"` —— 两条都不匹配且没有默认流，
 *   引擎会抛 `STATE_SHAPE_INVALID`（**这正是 D-22 要的行为**：无分支可走时抛错，
 *   绝不静默选一条）。所以这里换一条直行流程，只验证**落点**。
 */
const straightDef = {
  schemaVersion: '1.0.0',
  id: 'Definitions_1',
  processes: [
    {
      id: 'Process_1',
      nodes: [
        { id: 'Start_1', type: 'startEvent' },
        { id: 'BRT_1', type: 'businessRuleTask' },
        { id: 'Task_1', type: 'userTask', extension: approval('u_lead') },
        { id: 'End_1', type: 'endEvent' },
      ] as never,
      flows: [
        { id: 'f1', from: 'Start_1', to: 'BRT_1' },
        { id: 'f2', from: 'BRT_1', to: 'Task_1' },
        { id: 'f3', from: 'Task_1', to: 'End_1' },
      ] as never,
    },
  ],
} as unknown as ProcessDefinition;

const T0 = '2026-10-01T00:00:00.000Z';

function engineOn(
  amount: number,
  handler = createDecisionHandler(DMN, { decision: 'dec_1' }),
  definition: ProcessDefinition = def,
) {
  const store = createMemoryStore();
  const engine = createEngine({
    definitionSource: {
      async getDefinition(pid: string, v: number) {
        return pid === 'Process_1' && v === 1 ? definition : null;
      },
    },
    store,
    decisionHandler: handler,
    clock: () => T0,
  });
  return { engine, store, amount };
}

describe('★ 端到端：engine 的 businessRuleTask 走真 DMN', () => {
  it('决策结果进流程变量，并驱动排他网关选路', async () => {
    const { engine, store } = engineOn(8600);
    const id = await engine.start('Process_1', {
      definitionVersion: 1,
      starter: 'u_applicant',
      variables: { amount: 8600 },
    });

    const st = await store.load(id);
    expect(st?.variables['level']).toBe('商务');
    // 网关按决策结果选路：只应停在「大额」那条待办上
    expect(st?.tokens.filter((t) => t.state === 'active').map((t) => t.nodeId)).toEqual([
      'Task_big',
    ]);
    expect(st?.variables['amount']).toBe(8600); // 原变量不被覆盖
  });

  it('小额 → 走另一条分支', async () => {
    const { engine, store } = engineOn(800);
    const id = await engine.start('Process_1', {
      definitionVersion: 1,
      starter: 'u_applicant',
      variables: { amount: 800 },
    });
    const st = await store.load(id);
    expect(st?.variables['level']).toBe('经济');
    expect(st?.tokens.filter((t) => t.state === 'active').map((t) => t.nodeId)).toEqual([
      'Task_small',
    ]);
  });

  it('★ 不注入 decisionHandler → 引擎报「未配置」（dmn 缺席不静默直通）', async () => {
    const { engine } = engineOn(8600, undefined as never);
    // 显式清掉 decisionHandler 的办法：建一个没有它的引擎
    const bare = createEngine({
      definitionSource: {
        async getDefinition(pid: string) {
          return pid === 'Process_1' ? def : null;
        },
      },
      store: createMemoryStore(),
      clock: () => T0,
    });
    await expect(
      bare.start('Process_1', { definitionVersion: 1, starter: 'u_applicant', variables: { amount: 8600 } }),
    ).rejects.toThrowError(/decisionHandler/);
    void engine;
  });

  it("as:'node' 时结果落在节点 id 下（与 scriptTask 的 D-59 落点一致）", async () => {
    const { engine, store } = engineOn(
      8600,
      createDecisionHandler(DMN, { decision: 'dec_1', as: 'node' }),
      straightDef,
    );
    const id = await engine.start('Process_1', {
      definitionVersion: 1,
      starter: 'u_applicant',
      variables: { amount: 8600 },
    });
    const st = await store.load(id);
    expect(st?.variables['BRT_1']).toBe('商务');
    expect(st?.variables['level']).toBeUndefined();
    // 决策节点不该停下来等（它是 effect 节点），流程直推到 userTask
    expect(st?.tokens.filter((t) => t.state === 'active').map((t) => t.nodeId)).toEqual(['Task_1']);
  });
});
