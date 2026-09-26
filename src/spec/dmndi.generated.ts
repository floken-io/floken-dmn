// 自动生成 —— **不要手改**。改源后跑 `node scripts/gen-dmn-spec.mjs`。
// 权威源：OMG DMNDI15.xsd（complexType + 顶层 element 声明 + simpleType 枚举）。
// 生成时间：2026-09-26（仅记录，不参与 --check 比对）

import type { SpecProperty, SpecType } from './spec-types.js';

/** DMN 1.5 图形交换（`https://www.omg.org/spec/DMN/20230324/DMNDI/`） */
export const SPEC_TYPES: readonly SpecType[] = 
[
  {
    "name": "DMNDI",
    "superClass": [],
    "properties": [
      {
        "name": "DMNDiagram",
        "type": "DMNDiagram",
        "isMany": true
      },
      {
        "name": "DMNStyle",
        "type": "DMNStyle",
        "isMany": true
      }
    ]
  },
  {
    "name": "DMNDiagram",
    "superClass": [
      "Diagram"
    ],
    "properties": [
      {
        "name": "Size",
        "type": "Dimension"
      },
      {
        "name": "DMNDiagramElement",
        "type": "DiagramElement",
        "isMany": true
      },
      {
        "name": "useAlternativeInputDataShape",
        "type": "Boolean",
        "isAttr": true
      }
    ]
  },
  {
    "name": "DMNShape",
    "superClass": [
      "Shape"
    ],
    "properties": [
      {
        "name": "DMNLabel",
        "type": "DMNLabel"
      },
      {
        "name": "DMNDecisionServiceDividerLine",
        "type": "DMNDecisionServiceDividerLine"
      },
      {
        "name": "dmnElementRef",
        "type": "String",
        "isAttr": true
      },
      {
        "name": "isListedInputData",
        "type": "Boolean",
        "isAttr": true
      },
      {
        "name": "isCollapsed",
        "type": "Boolean",
        "isAttr": true
      }
    ]
  },
  {
    "name": "DMNDecisionServiceDividerLine",
    "superClass": [
      "Edge"
    ],
    "properties": []
  },
  {
    "name": "DMNEdge",
    "superClass": [
      "Edge"
    ],
    "properties": [
      {
        "name": "DMNLabel",
        "type": "DMNLabel"
      },
      {
        "name": "dmnElementRef",
        "type": "String",
        "isAttr": true
      },
      {
        "name": "sourceElement",
        "type": "String",
        "isAttr": true
      },
      {
        "name": "targetElement",
        "type": "String",
        "isAttr": true
      }
    ]
  },
  {
    "name": "DMNLabel",
    "superClass": [
      "Shape"
    ],
    "properties": [
      {
        "name": "Text",
        "type": "String"
      }
    ]
  },
  {
    "name": "DMNStyle",
    "superClass": [
      "Style"
    ],
    "properties": [
      {
        "name": "FillColor",
        "type": "Color"
      },
      {
        "name": "StrokeColor",
        "type": "Color"
      },
      {
        "name": "FontColor",
        "type": "Color"
      },
      {
        "name": "fontFamily",
        "type": "String",
        "isAttr": true
      },
      {
        "name": "fontSize",
        "type": "Number",
        "isAttr": true
      },
      {
        "name": "fontItalic",
        "type": "Boolean",
        "isAttr": true
      },
      {
        "name": "fontBold",
        "type": "Boolean",
        "isAttr": true
      },
      {
        "name": "fontUnderline",
        "type": "Boolean",
        "isAttr": true
      },
      {
        "name": "fontStrikeThrough",
        "type": "Boolean",
        "isAttr": true
      },
      {
        "name": "labelHorizontalAlignement",
        "type": "AlignmentKind",
        "isAttr": true
      },
      {
        "name": "labelVerticalAlignment",
        "type": "AlignmentKind",
        "isAttr": true
      }
    ]
  }
];

export const SPEC_TYPE_BY_NAME: Readonly<Record<string, SpecType>> = Object.fromEntries(
  SPEC_TYPES.map((t) => [t.name, t]),
);

/** 可实例化的类型名（抽象基类不在内） */
export const CONCRETE_TYPES: readonly string[] = SPEC_TYPES.filter((t) => !t.isAbstract).map((t) => t.name);

/** 全部自有属性数（规格自证用） */
export const OWN_PROPERTY_COUNT: number = SPEC_TYPES.reduce((n, t) => n + t.properties.length, 0);

/**
 * **XML 元素名 → 类型名**。
 *
 * ★ 这是 reader 解析**抽象基类**的唯一切入点：`<definitions>` 下的属性声明是
 * `drgElement: DRGElement`（抽象），而文件里写的实际是 `<decision>` / `<inputData>`。
 * 只靠属性声明无法确定具体类型，必须按元素名反查。
 */
export const ELEMENT_NAME_TO_TYPE: Readonly<Record<string, string>> = 
{
  "DMNDI": "DMNDI",
  "DMNDiagram": "DMNDiagram",
  "DMNShape": "DMNShape",
  "DMNEdge": "DMNEdge",
  "DMNStyle": "DMNStyle",
  "DMNLabel": "DMNLabel",
  "DMNDecisionServiceDividerLine": "DMNDecisionServiceDividerLine"
};
