// 描述符查询 API —— 把两份 `*.generated.ts`（语义 + 图形交换）合成一个可查询的目录。
//
// 描述符只是**数据**：本包不引 moddle（Q38），读写器按这张表解释 XML。
import type { SpecProperty, SpecType } from './spec-types.js';
import { SPEC_TYPES as DMN_TYPES, ELEMENT_NAME_TO_TYPE as DMN_ELEMENTS, SPEC_ENUMS as DMN_ENUMS } from './dmn.generated.js';
import { SPEC_TYPES as DI_TYPES, ELEMENT_NAME_TO_TYPE as DI_ELEMENTS } from './dmndi.generated.js';

export type { SpecProperty, SpecType };

// --------------------------------------------------------------------------
// 命名空间（★ Q35：权威 1.5，导入双向兼容 1.3/1.4/1.5/1.6）
// --------------------------------------------------------------------------

export const NS_20191111 = 'https://www.omg.org/spec/DMN/20191111/MODEL/'; // 1.3
export const NS_20211108 = 'https://www.omg.org/spec/DMN/20211108/MODEL/'; // 1.4
export const NS_20230324 = 'https://www.omg.org/spec/DMN/20230324/MODEL/'; // 1.5 —— **权威**
export const NS_20240513 = 'https://www.omg.org/spec/DMN/20240513/MODEL/'; // 1.6

/** 导入时接受的四档命名空间 → 版本标签 */
export const ACCEPTED_NAMESPACES: Readonly<Record<string, string>> = {
  [NS_20191111]: '1.3',
  [NS_20211108]: '1.4',
  [NS_20230324]: '1.5',
  [NS_20240513]: '1.6',
};

/** 导出口径：恒写 1.5，不随读入版本变 */
export const EXPORT_NAMESPACE = NS_20230324;
export const EXPORT_VERSION = '1.5';

export const DMNDI_NS_20230324 = 'https://www.omg.org/spec/DMN/20230324/DMNDI/';
export const DMNDI_NS_20191111 = 'https://www.omg.org/spec/DMN/20191111/DMNDI/';

/** FEEL 语言 URI（DMN 1.5 默认值，取自 DMN15.xsd） */
export const FEEL_URI_20230324 = 'https://www.omg.org/spec/DMN/20230324/FEEL/';
/** ★ 1.6 专有方言 B-FEEL —— 遇则报错，禁止静默降级（Q35） */
export const BFEEL_URI_20240513 = 'https://www.omg.org/spec/DMN/20240513/B-FEEL/';

export function versionOfNamespace(ns: string): string | null {
  return ACCEPTED_NAMESPACES[ns] ?? null;
}

// --------------------------------------------------------------------------
// 类型目录
// --------------------------------------------------------------------------

const TYPES: Readonly<Record<string, SpecType>> = Object.freeze(
  Object.fromEntries([...DMN_TYPES, ...DI_TYPES].map((t) => [t.name, t])),
);

const ELEMENTS: Readonly<Record<string, string>> = Object.freeze({ ...DMN_ELEMENTS, ...DI_ELEMENTS });

/** 原子类型（不会再展开） */
const ATOMIC = new Set(['String', 'Boolean', 'Number']);

export function isAtomicType(name: string): boolean {
  return ATOMIC.has(name);
}

export function getType(name: string | undefined): SpecType | undefined {
  return name ? TYPES[name] : undefined;
}

/**
 * 类型名 → XML 元素名（writer 用；抽象类型没有元素名，回写时会跳过）。
 * 同一类型有多个元素名时（`Some`/`Every`），优先取与类型名小写一致的那个。
 */
export const TYPE_TO_ELEMENT_NAME: Readonly<Record<string, string>> = Object.freeze(
  (() => {
    const out: Record<string, string> = {};
    for (const [elName, typeName] of Object.entries(ELEMENTS)) {
      if (out[typeName] && out[typeName] !== typeName.toLowerCase()) continue;
      out[typeName] = elName;
    }
    return out;
  })(),
);

/** 元素名 → 类型名（解析抽象基类的唯一切入点） */
export function typeOfElementName(localName: string): string | undefined {
  return ELEMENTS[localName];
}

/** 该类型的全部属性（含继承，子类同名属性覆盖祖先） */
export function allProperties(typeName_: string | undefined): SpecProperty[] {
  const seen = new Set<string>();
  const out: SpecProperty[] = [];
  let cur = getType(typeName_);
  while (cur) {
    for (const p of cur.properties) {
      if (seen.has(p.name)) continue;
      seen.add(p.name);
      out.push(p);
    }
    cur = getType(cur.superClass[0]);
  }
  return out;
}

export function findProperty(typeName_: string | undefined, propName: string): SpecProperty | undefined {
  return allProperties(typeName_).find((p) => p.name === propName);
}

/** `a` 是否是 `b`（含自身）的子类型 */
export function isSubtypeOf(a: string | undefined, b: string): boolean {
  let cur = getType(a);
  while (cur) {
    if (cur.name === b) return true;
    cur = getType(cur.superClass[0]);
  }
  return false;
}

/** 可实例化的类型名（抽象基类不在内） */
export const CONCRETE_TYPE_NAMES: readonly string[] = Object.values(TYPES)
  .filter((t) => !t.isAbstract)
  .map((t) => t.name);

/** 某个抽象类型的全部后代（含自身）—— 用于「Expression 的后代」这类集合推导 */
export function descendantsOf(abstractName: string): string[] {
  return Object.values(TYPES)
    .filter((t) => isSubtypeOf(t.name, abstractName))
    .map((t) => t.name);
}

export const ENUMS: Readonly<Record<string, readonly string[]>> = DMN_ENUMS;

/** 规模自证（`test/spec.test.ts` 用）—— 文档口径：55 类型 / 121+ 自有属性 */
export const SPEC_STATS = {
  dmnTypes: DMN_TYPES.length,
  diTypes: DI_TYPES.length,
  dmnOwnProperties: DMN_TYPES.reduce((n, t) => n + t.properties.length, 0),
  enums: Object.keys(DMN_ENUMS).length,
  concrete: CONCRETE_TYPE_NAMES.length,
} as const;
