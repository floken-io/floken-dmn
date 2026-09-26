// 描述符的类型形状（手写；`*.generated.ts` 依赖它）。
//
// 形状与 moddle 的 `ModdleDescriptor` 同构（`name` / `superClass` / `properties`），
// 但**不引入 moddle**：本包按 Q38 自研读写，描述符只是数据 + 查询 API。

/** 一个属性声明 */
export interface SpecProperty {
  /** 属性名（XML 里就是元素名 / 属性名） */
  name: string;
  /** 类型：原子类型 `String`/`Boolean`/`Number`，或另一个 SpecType 的 name */
  type: string;
  /** true = XML 属性（`@name=`），false/缺省 = XML 子元素 */
  isAttr?: boolean;
  /** true = 可重复（集合） */
  isMany?: boolean;
}

/** 一个类型声明 */
export interface SpecType {
  name: string;
  /** 父类名（单继承，DMN 的 XSD 只用了 extension 单继承） */
  superClass: string[];
  properties: SpecProperty[];
  /** 抽象基类：不可实例化，只作继承与被引用 */
  isAbstract?: boolean;
}

/** 一份描述符（语义 / 图形交换各一份） */
export interface Spec {
  name: string;
  prefix: string;
  uri: string;
  types: readonly SpecType[];
  enums?: Readonly<Record<string, readonly string[]>>;
}
