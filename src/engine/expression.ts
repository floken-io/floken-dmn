// 盒装表达式的结构执行 —— 本包**不做任何求值**，只做结构分派（边界第 1 条）。
//
// 语义对照：DMN 1.5 §7 与参考实现 `dmn-elements/src/decisionLogic/*`（MIT）。
// 每种盒装表达式的全部难点都在「把结构翻译成对 FEEL 的一次次调用」。
import { DecisionError, diag, type Diagnostic } from '../core/errors.js';
import { isElement, type DmnElement } from '../xml/reader.js';
import { coerceTypeRef, evalExpression, evalUnaryTests, toFeelContext } from './feel.js';
import { evaluateDecisionTable } from './decision-table.js';
import type { ModelIndex } from './drg.js';

/** 求值作用域：只有「变量字典 + 模型索引」会传进 FEEL（边界第 2 条） */
export interface EvalScope {
  vars: Record<string, unknown>;
  index: ModelIndex;
  definitions: DmnElement;
  diagnostics: Diagnostic[];
  expressionLanguage?: string | undefined;
}

const asArray = (v: unknown): DmnElement[] => (Array.isArray(v) ? v.filter(isElement) : isElement(v) ? [v] : []);
const textOf = (el: unknown): string => (isElement(el) && typeof el.text === 'string' ? el.text.trim() : '');

/** `ChildExpression` / `TypedChildExpression` → 它包着的那个 Expression */
function childExpression(el: unknown): DmnElement | undefined {
  if (!isElement(el)) return undefined;
  const inner = el.expression;
  return isElement(inner) ? inner : undefined;
}

/**
 * 求值一个盒装表达式。
 * @param trace 决策的 trace 条目（决策表会往里写命中规则）
 */
export function evaluateExpression(
  expr: DmnElement,
  scope: EvalScope,
  trace?: { matchedRules?: string[]; hitPolicy?: string },
): unknown {
  const typeRef = expr.typeRef;
  const coerce = (v: unknown) => coerceTypeRef(v, typeRef, { id: expr.$id ?? '' });

  switch (expr.$type) {
    case 'LiteralExpression': {
      const text = textOf(expr);
      if (!text) return null;
      const r = evalExpression(text, scope.vars, { id: expr.$id ?? '', path: 'literalExpression.text' });
      scope.diagnostics.push(...r.warnings);
      return coerce(r.value);
    }

    case 'DecisionTable': {
      const out = evaluateDecisionTable(expr, scope, trace);
      return coerce(out.value);
    }

    /*
     * ★ 盒装 context 的值（DMN 1.5 §7.4）——**不是**"最后一个 entry 的值"：
     *
     *   ①最后一个 entry **没有** `<variable>` → 整个 context 的值就是**它**的值；
     *   ②否则 → 值就是**这个 context 本身**（只有带名字的 entry 进结果）。
     *
     * 之前一律返回最后一个 entry，于是 `{resolve A: "A"}` 被压成 `"A"`，
     * 嵌套引用（`decision A 2.1` 取 `decision A 1`）随之全线断掉（TCK 0034 整组）。
     *
     * 另：entry 之间**顺序可见** —— 后一个 entry 能引用前一个的绑定（DRG 作用域），
     * 故用派生作用域 `local`，不直接往外层 `scope.vars` 上写（避免污染兄弟决策）。
     */
    case 'Context': {
      const entries = asArray(expr.contextEntry);
      const local: Record<string, unknown> = { ...scope.vars };
      const named: Record<string, unknown> = {};
      let tail: unknown = null;
      let hasTail = false;
      for (const entry of entries) {
        const inner = entry.expression;
        const value = isElement(inner)
          ? evaluateExpression(inner, { ...scope, vars: local })
          : null;
        const variable = entry.variable;
        const name =
          isElement(variable) && typeof variable.name === 'string' && variable.name ? variable.name : '';
        if (name) {
          local[name] = value;
          named[name] = value;
        } else {
          tail = value;
          hasTail = true;
        }
      }
      return coerce(hasTail ? tail : toFeelContext(named));
    }

    case 'List': {
      const items = asArray(expr.expression);
      return coerce(items.map((item) => evaluateExpression(item, scope)));
    }

    case 'Relation': {
      const columns = asArray(expr.column).map((c) => (typeof c.name === 'string' ? c.name : ''));
      const rows = asArray(expr.row);
      const out: Array<Record<string, unknown>> = [];
      for (const row of rows) {
        const values = asArray(row.expression).map((e) => evaluateExpression(e, scope));
        const rec: Record<string, unknown> = {};
        for (const [i, name] of columns.entries()) {
          if (name) rec[name] = values[i] ?? null;
          else rec[`column${i + 1}`] = values[i] ?? null;
        }
        out.push(rec);
      }
      return coerce(out);
    }

    case 'FunctionDefinition':
      return makeFunction(expr, scope);

    case 'Invocation': {
      // 被调函数：优先按名字从作用域取（BKM 绑在这里），否则求值 expression 本身
      const fnExpr = childExpression(expr) ?? (isElement(expr.expression) ? expr.expression : undefined);
      const fnName = fnExpr && fnExpr.$type === 'LiteralExpression' ? textOf(fnExpr) : '';
      const fn = fnName ? scope.vars[fnName] : fnExpr ? evaluateExpression(fnExpr, scope) : undefined;
      if (typeof fn !== 'function') {
        throw new DecisionError({
          code: 'DMN_EVAL_UNSUPPORTED_EXPRESSION',
          message: 'invocation 的目标不是可调用的函数',
          node: { id: expr.$id ?? '' },
          details: { name: fnName || '(匿名)' },
        });
      }
      const args: unknown[] = [];
      const named: Record<string, unknown> = {};
      for (const binding of asArray(expr.binding)) {
        const inner = binding.expression;
        const value = isElement(inner) ? evaluateExpression(inner, scope) : null;
        const param = binding.parameter;
        const pname = isElement(param) && typeof param.name === 'string' ? param.name : '';
        if (pname) named[pname] = value;
        args.push(value);
      }
      // 命名实参优先：FEEL 的命名调用语义（`f(a: 1)`）
      const useNamed = Object.keys(named).length === args.length && args.length > 0;
      return coerce(useNamed ? (fn as (a: Record<string, unknown>) => unknown)(named) : (fn as (...a: unknown[]) => unknown)(...args));
    }

    case 'Conditional': {
      const condExpr = childExpression(expr.if);
      if (!condExpr) {
        throw new DecisionError({
          code: 'DMN_EVAL_UNSUPPORTED_EXPRESSION',
          message: 'conditional 缺少 if 分支',
          node: { id: expr.$id ?? '' },
        });
      }
      const cond = evaluateExpression(condExpr, scope);
      if (typeof cond !== 'boolean') {
        throw new DecisionError({
          code: 'DMN_EVAL_UNSUPPORTED_EXPRESSION',
          message: 'conditional 的 if 分支必须求值为布尔',
          node: { id: expr.$id ?? '' },
          details: { got: cond === null ? 'null' : typeof cond },
        });
      }
      const branch = childExpression(cond ? expr.then : expr.else);
      return coerce(branch ? evaluateExpression(branch, scope) : null);
    }

    case 'Filter': {
      const list = evalChildList(expr, 'in', scope);
      const matchDef = childExpression(expr.match);
      if (!matchDef) {
        throw new DecisionError({
          code: 'DMN_EVAL_UNSUPPORTED_EXPRESSION',
          message: 'filter 缺少 match 表达式',
          node: { id: expr.$id ?? '' },
        });
      }
      const out: unknown[] = [];
      for (const item of list) {
        // FEEL filter 作用域：context 元素把它的条目平铺出来，另加隐式 `item`
        const entries = item && typeof item === 'object' && !Array.isArray(item) ? (item as Record<string, unknown>) : {};
        const local = { ...scope.vars, ...entries, item };
        const r = evaluateExpression(matchDef, { ...scope, vars: local });
        if (typeof r !== 'boolean') {
          throw new DecisionError({
            code: 'DMN_EVAL_UNSUPPORTED_EXPRESSION',
            message: 'filter 的 match 必须求值为布尔',
            node: { id: expr.$id ?? '' },
            details: { got: r === null ? 'null' : typeof r },
          });
        }
        if (r) out.push(item);
      }
      return coerce(out);
    }

    case 'For':
    case 'Some':
    case 'Every': {
      const iter = typeof expr.iteratorVariable === 'string' ? expr.iteratorVariable : '';
      if (!iter) {
        throw new DecisionError({
          code: 'DMN_EVAL_UNSUPPORTED_EXPRESSION',
          message: `${expr.$type.toLowerCase()} 缺少 iteratorVariable`,
          node: { id: expr.$id ?? '' },
        });
      }
      const list = evalChildList(expr, 'in', scope);
      if (expr.$type === 'For') {
        const retDef = childExpression(expr.return);
        if (!retDef) {
          throw new DecisionError({
            code: 'DMN_EVAL_UNSUPPORTED_EXPRESSION',
            message: 'for 缺少 return 表达式',
            node: { id: expr.$id ?? '' },
          });
        }
        const results: unknown[] = [];
        for (const element of list) {
          const local = { ...scope.vars, [iter]: element, partial: [...results] };
          results.push(evaluateExpression(retDef, { ...scope, vars: local }));
        }
        return coerce(results);
      }
      const satDef = childExpression(expr.satisfies);
      if (!satDef) {
        throw new DecisionError({
          code: 'DMN_EVAL_UNSUPPORTED_EXPRESSION',
          message: `${expr.$type.toLowerCase()} 缺少 satisfies 表达式`,
          node: { id: expr.$id ?? '' },
        });
      }
      const want = expr.$type === 'Some';
      for (const element of list) {
        const local = { ...scope.vars, [iter]: element };
        const r = evaluateExpression(satDef, { ...scope, vars: local });
        if (typeof r !== 'boolean') {
          throw new DecisionError({
            code: 'DMN_EVAL_UNSUPPORTED_EXPRESSION',
            message: 'satisfies 必须求值为布尔',
            node: { id: expr.$id ?? '' },
            details: { got: r === null ? 'null' : typeof r },
          });
        }
        if (r === want) return want; // 短路：some 命中 / every 落空
      }
      return coerce(!want); // 空列表：some=false，every=true
    }

    default:
      throw new DecisionError({
        code: 'DMN_EVAL_UNSUPPORTED_EXPRESSION',
        message: '不支持的表达式类型',
        node: { id: expr.$id ?? '' },
        details: { type: expr.$type },
      });
  }
}

/** `in` 子表达式必须求值为 list */
function evalChildList(expr: DmnElement, key: string, scope: EvalScope): unknown[] {
  const child = childExpression(expr[key]);
  const value = child ? evaluateExpression(child, scope) : null;
  if (!Array.isArray(value)) {
    throw new DecisionError({
      code: 'DMN_EVAL_UNSUPPORTED_EXPRESSION',
      message: `${expr.$type.toLowerCase()} 的 ${key} 必须求值为列表`,
      node: { id: expr.$id ?? '' },
      details: { got: value === null ? 'null' : Array.isArray(value) ? 'list' : typeof value },
    });
  }
  return value;
}

/** FunctionDefinition → FEEL 可调用（闭合作用域） */
function makeFunction(expr: DmnElement, scope: EvalScope): unknown {
  const body = childExpression(expr.expression);
  const params = asArray(expr.formalParameter).map((p) => (typeof p.name === 'string' ? p.name : ''));
  if (!body) return null;
  const fn = (...args: unknown[]): unknown => {
    const local: Record<string, unknown> = { ...scope.vars };
    for (const [i, name] of params.entries()) {
      if (name) local[name] = args[i];
    }
    return evaluateExpression(body, { ...scope, vars: local });
  };
  Object.defineProperty(fn, '$args', { value: params, enumerable: false });
  return fn;
}

export { diag, evalUnaryTests };
