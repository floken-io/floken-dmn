// 自动生成 —— **不要手改**。改源后跑 `node scripts/gen-dmn-spec.mjs`。
// 权威源：OMG DMN15.xsd（complexType + 顶层 element 声明 + simpleType 枚举）。
// 生成时间：2026-09-26（仅记录，不参与 --check 比对）

import type { SpecProperty, SpecType } from './spec-types.js';

/** DMN 1.5 语义元模型（`https://www.omg.org/spec/DMN/20230324/MODEL/`） */
export const SPEC_TYPES: readonly SpecType[] = 
[
  {
    "name": "DMNElement",
    "superClass": [],
    "properties": [
      {
        "name": "description",
        "type": "String"
      },
      {
        "name": "extensionElements",
        "type": "ExtensionElements"
      },
      {
        "name": "id",
        "type": "String",
        "isAttr": true
      },
      {
        "name": "label",
        "type": "String",
        "isAttr": true
      }
    ],
    "isAbstract": true
  },
  {
    "name": "NamedElement",
    "superClass": [
      "DMNElement"
    ],
    "properties": [
      {
        "name": "name",
        "type": "String",
        "isAttr": true
      }
    ],
    "isAbstract": true
  },
  {
    "name": "DMNElementReference",
    "superClass": [],
    "properties": [
      {
        "name": "href",
        "type": "String",
        "isAttr": true
      }
    ]
  },
  {
    "name": "Definitions",
    "superClass": [
      "NamedElement"
    ],
    "properties": [
      {
        "name": "import",
        "type": "Import",
        "isMany": true
      },
      {
        "name": "itemDefinition",
        "type": "ItemDefinition",
        "isMany": true
      },
      {
        "name": "drgElement",
        "type": "DRGElement",
        "isMany": true
      },
      {
        "name": "artifact",
        "type": "Artifact",
        "isMany": true
      },
      {
        "name": "elementCollection",
        "type": "ElementCollection",
        "isMany": true
      },
      {
        "name": "businessContextElement",
        "type": "BusinessContextElement",
        "isMany": true
      },
      {
        "name": "DMNDI",
        "type": "DMNDI"
      },
      {
        "name": "expressionLanguage",
        "type": "String",
        "isAttr": true
      },
      {
        "name": "typeLanguage",
        "type": "String",
        "isAttr": true
      },
      {
        "name": "namespace",
        "type": "String",
        "isAttr": true
      },
      {
        "name": "exporter",
        "type": "String",
        "isAttr": true
      },
      {
        "name": "exporterVersion",
        "type": "String",
        "isAttr": true
      }
    ]
  },
  {
    "name": "Import",
    "superClass": [
      "NamedElement"
    ],
    "properties": [
      {
        "name": "namespace",
        "type": "String",
        "isAttr": true
      },
      {
        "name": "locationURI",
        "type": "String",
        "isAttr": true
      },
      {
        "name": "importType",
        "type": "String",
        "isAttr": true
      }
    ]
  },
  {
    "name": "ElementCollection",
    "superClass": [
      "NamedElement"
    ],
    "properties": [
      {
        "name": "drgElement",
        "type": "DMNElementReference",
        "isMany": true
      }
    ]
  },
  {
    "name": "DRGElement",
    "superClass": [
      "NamedElement"
    ],
    "properties": [],
    "isAbstract": true
  },
  {
    "name": "Decision",
    "superClass": [
      "DRGElement"
    ],
    "properties": [
      {
        "name": "question",
        "type": "String"
      },
      {
        "name": "allowedAnswers",
        "type": "String"
      },
      {
        "name": "variable",
        "type": "InformationItem"
      },
      {
        "name": "informationRequirement",
        "type": "InformationRequirement",
        "isMany": true
      },
      {
        "name": "knowledgeRequirement",
        "type": "KnowledgeRequirement",
        "isMany": true
      },
      {
        "name": "authorityRequirement",
        "type": "AuthorityRequirement",
        "isMany": true
      },
      {
        "name": "supportedObjective",
        "type": "DMNElementReference",
        "isMany": true
      },
      {
        "name": "impactedPerformanceIndicator",
        "type": "DMNElementReference",
        "isMany": true
      },
      {
        "name": "decisionMaker",
        "type": "DMNElementReference",
        "isMany": true
      },
      {
        "name": "decisionOwner",
        "type": "DMNElementReference",
        "isMany": true
      },
      {
        "name": "usingProcess",
        "type": "DMNElementReference",
        "isMany": true
      },
      {
        "name": "usingTask",
        "type": "DMNElementReference",
        "isMany": true
      },
      {
        "name": "expression",
        "type": "Expression"
      }
    ]
  },
  {
    "name": "BusinessContextElement",
    "superClass": [
      "NamedElement"
    ],
    "properties": [
      {
        "name": "URI",
        "type": "String",
        "isAttr": true
      }
    ],
    "isAbstract": true
  },
  {
    "name": "PerformanceIndicator",
    "superClass": [
      "BusinessContextElement"
    ],
    "properties": [
      {
        "name": "impactingDecision",
        "type": "DMNElementReference",
        "isMany": true
      }
    ]
  },
  {
    "name": "OrganisationalUnit",
    "superClass": [
      "BusinessContextElement"
    ],
    "properties": [
      {
        "name": "decisionMade",
        "type": "DMNElementReference",
        "isMany": true
      },
      {
        "name": "decisionOwned",
        "type": "DMNElementReference",
        "isMany": true
      }
    ]
  },
  {
    "name": "Invocable",
    "superClass": [
      "DRGElement"
    ],
    "properties": [
      {
        "name": "variable",
        "type": "InformationItem"
      }
    ],
    "isAbstract": true
  },
  {
    "name": "BusinessKnowledgeModel",
    "superClass": [
      "Invocable"
    ],
    "properties": [
      {
        "name": "encapsulatedLogic",
        "type": "FunctionDefinition"
      },
      {
        "name": "knowledgeRequirement",
        "type": "KnowledgeRequirement",
        "isMany": true
      },
      {
        "name": "authorityRequirement",
        "type": "AuthorityRequirement",
        "isMany": true
      }
    ]
  },
  {
    "name": "InputData",
    "superClass": [
      "DRGElement"
    ],
    "properties": [
      {
        "name": "variable",
        "type": "InformationItem"
      }
    ]
  },
  {
    "name": "KnowledgeSource",
    "superClass": [
      "DRGElement"
    ],
    "properties": [
      {
        "name": "authorityRequirement",
        "type": "AuthorityRequirement",
        "isMany": true
      },
      {
        "name": "type",
        "type": "String"
      },
      {
        "name": "owner",
        "type": "DMNElementReference"
      },
      {
        "name": "locationURI",
        "type": "String",
        "isAttr": true
      }
    ]
  },
  {
    "name": "InformationRequirement",
    "superClass": [
      "DMNElement"
    ],
    "properties": [
      {
        "name": "requiredDecision",
        "type": "DMNElementReference"
      },
      {
        "name": "requiredInput",
        "type": "DMNElementReference"
      }
    ]
  },
  {
    "name": "KnowledgeRequirement",
    "superClass": [
      "DMNElement"
    ],
    "properties": [
      {
        "name": "requiredKnowledge",
        "type": "DMNElementReference"
      }
    ]
  },
  {
    "name": "AuthorityRequirement",
    "superClass": [
      "DMNElement"
    ],
    "properties": [
      {
        "name": "requiredDecision",
        "type": "DMNElementReference"
      },
      {
        "name": "requiredInput",
        "type": "DMNElementReference"
      },
      {
        "name": "requiredAuthority",
        "type": "DMNElementReference"
      }
    ]
  },
  {
    "name": "Expression",
    "superClass": [
      "DMNElement"
    ],
    "properties": [
      {
        "name": "typeRef",
        "type": "String",
        "isAttr": true
      }
    ],
    "isAbstract": true
  },
  {
    "name": "ItemDefinition",
    "superClass": [
      "NamedElement"
    ],
    "properties": [
      {
        "name": "typeRef",
        "type": "String"
      },
      {
        "name": "allowedValues",
        "type": "UnaryTests"
      },
      {
        "name": "typeConstraint",
        "type": "UnaryTests"
      },
      {
        "name": "itemComponent",
        "type": "ItemDefinition",
        "isMany": true
      },
      {
        "name": "functionItem",
        "type": "FunctionItem"
      },
      {
        "name": "typeLanguage",
        "type": "String",
        "isAttr": true
      },
      {
        "name": "isCollection",
        "type": "Boolean",
        "isAttr": true
      }
    ]
  },
  {
    "name": "FunctionItem",
    "superClass": [
      "DMNElement"
    ],
    "properties": [
      {
        "name": "parameters",
        "type": "InformationItem",
        "isMany": true
      },
      {
        "name": "outputTypeRef",
        "type": "String",
        "isAttr": true
      }
    ]
  },
  {
    "name": "LiteralExpression",
    "superClass": [
      "Expression"
    ],
    "properties": [
      {
        "name": "text",
        "type": "String"
      },
      {
        "name": "importedValues",
        "type": "ImportedValues"
      },
      {
        "name": "expressionLanguage",
        "type": "String",
        "isAttr": true
      }
    ]
  },
  {
    "name": "Invocation",
    "superClass": [
      "Expression"
    ],
    "properties": [
      {
        "name": "expression",
        "type": "Expression"
      },
      {
        "name": "binding",
        "type": "Binding",
        "isMany": true
      }
    ]
  },
  {
    "name": "Binding",
    "superClass": [],
    "properties": [
      {
        "name": "parameter",
        "type": "InformationItem"
      },
      {
        "name": "expression",
        "type": "Expression"
      }
    ]
  },
  {
    "name": "InformationItem",
    "superClass": [
      "NamedElement"
    ],
    "properties": [
      {
        "name": "typeRef",
        "type": "String",
        "isAttr": true
      }
    ]
  },
  {
    "name": "DecisionTable",
    "superClass": [
      "Expression"
    ],
    "properties": [
      {
        "name": "input",
        "type": "InputClause",
        "isMany": true
      },
      {
        "name": "output",
        "type": "OutputClause",
        "isMany": true
      },
      {
        "name": "annotation",
        "type": "RuleAnnotationClause",
        "isMany": true
      },
      {
        "name": "rule",
        "type": "DecisionRule",
        "isMany": true
      },
      {
        "name": "hitPolicy",
        "type": "HitPolicy",
        "isAttr": true
      },
      {
        "name": "aggregation",
        "type": "BuiltinAggregator",
        "isAttr": true
      },
      {
        "name": "preferredOrientation",
        "type": "DecisionTableOrientation",
        "isAttr": true
      },
      {
        "name": "outputLabel",
        "type": "String",
        "isAttr": true
      }
    ]
  },
  {
    "name": "InputClause",
    "superClass": [
      "DMNElement"
    ],
    "properties": [
      {
        "name": "inputExpression",
        "type": "LiteralExpression"
      },
      {
        "name": "inputValues",
        "type": "UnaryTests"
      }
    ]
  },
  {
    "name": "OutputClause",
    "superClass": [
      "DMNElement"
    ],
    "properties": [
      {
        "name": "outputValues",
        "type": "UnaryTests"
      },
      {
        "name": "defaultOutputEntry",
        "type": "LiteralExpression"
      },
      {
        "name": "name",
        "type": "String",
        "isAttr": true
      },
      {
        "name": "typeRef",
        "type": "String",
        "isAttr": true
      }
    ]
  },
  {
    "name": "RuleAnnotationClause",
    "superClass": [],
    "properties": [
      {
        "name": "name",
        "type": "String",
        "isAttr": true
      }
    ]
  },
  {
    "name": "DecisionRule",
    "superClass": [
      "DMNElement"
    ],
    "properties": [
      {
        "name": "inputEntry",
        "type": "UnaryTests",
        "isMany": true
      },
      {
        "name": "outputEntry",
        "type": "LiteralExpression",
        "isMany": true
      },
      {
        "name": "annotationEntry",
        "type": "RuleAnnotation",
        "isMany": true
      }
    ]
  },
  {
    "name": "RuleAnnotation",
    "superClass": [],
    "properties": [
      {
        "name": "text",
        "type": "String"
      }
    ]
  },
  {
    "name": "ImportedValues",
    "superClass": [
      "Import"
    ],
    "properties": [
      {
        "name": "importedElement",
        "type": "String"
      },
      {
        "name": "expressionLanguage",
        "type": "String",
        "isAttr": true
      }
    ]
  },
  {
    "name": "Artifact",
    "superClass": [
      "DMNElement"
    ],
    "properties": [],
    "isAbstract": true
  },
  {
    "name": "Group",
    "superClass": [
      "Artifact"
    ],
    "properties": [
      {
        "name": "name",
        "type": "String",
        "isAttr": true
      }
    ]
  },
  {
    "name": "TextAnnotation",
    "superClass": [
      "Artifact"
    ],
    "properties": [
      {
        "name": "text",
        "type": "String"
      },
      {
        "name": "textFormat",
        "type": "String",
        "isAttr": true
      }
    ]
  },
  {
    "name": "Association",
    "superClass": [
      "Artifact"
    ],
    "properties": [
      {
        "name": "sourceRef",
        "type": "DMNElementReference"
      },
      {
        "name": "targetRef",
        "type": "DMNElementReference"
      },
      {
        "name": "associationDirection",
        "type": "AssociationDirection",
        "isAttr": true
      }
    ]
  },
  {
    "name": "Context",
    "superClass": [
      "Expression"
    ],
    "properties": [
      {
        "name": "contextEntry",
        "type": "ContextEntry",
        "isMany": true
      }
    ]
  },
  {
    "name": "ContextEntry",
    "superClass": [
      "DMNElement"
    ],
    "properties": [
      {
        "name": "variable",
        "type": "InformationItem"
      },
      {
        "name": "expression",
        "type": "Expression"
      }
    ]
  },
  {
    "name": "FunctionDefinition",
    "superClass": [
      "Expression"
    ],
    "properties": [
      {
        "name": "formalParameter",
        "type": "InformationItem",
        "isMany": true
      },
      {
        "name": "expression",
        "type": "Expression"
      },
      {
        "name": "kind",
        "type": "FunctionKind",
        "isAttr": true
      }
    ]
  },
  {
    "name": "Relation",
    "superClass": [
      "Expression"
    ],
    "properties": [
      {
        "name": "column",
        "type": "InformationItem",
        "isMany": true
      },
      {
        "name": "row",
        "type": "List",
        "isMany": true
      }
    ]
  },
  {
    "name": "List",
    "superClass": [
      "Expression"
    ],
    "properties": [
      {
        "name": "expression",
        "type": "Expression",
        "isMany": true
      }
    ]
  },
  {
    "name": "UnaryTests",
    "superClass": [
      "Expression"
    ],
    "properties": [
      {
        "name": "text",
        "type": "String"
      },
      {
        "name": "expressionLanguage",
        "type": "String",
        "isAttr": true
      }
    ]
  },
  {
    "name": "DecisionService",
    "superClass": [
      "Invocable"
    ],
    "properties": [
      {
        "name": "outputDecision",
        "type": "DMNElementReference",
        "isMany": true
      },
      {
        "name": "encapsulatedDecision",
        "type": "DMNElementReference",
        "isMany": true
      },
      {
        "name": "inputDecision",
        "type": "DMNElementReference",
        "isMany": true
      },
      {
        "name": "inputData",
        "type": "DMNElementReference",
        "isMany": true
      }
    ]
  },
  {
    "name": "ChildExpression",
    "superClass": [],
    "properties": [
      {
        "name": "expression",
        "type": "Expression"
      },
      {
        "name": "id",
        "type": "String",
        "isAttr": true
      }
    ]
  },
  {
    "name": "TypedChildExpression",
    "superClass": [
      "ChildExpression"
    ],
    "properties": [
      {
        "name": "typeRef",
        "type": "String",
        "isAttr": true
      }
    ]
  },
  {
    "name": "Iterator",
    "superClass": [
      "Expression"
    ],
    "properties": [
      {
        "name": "in",
        "type": "TypedChildExpression"
      },
      {
        "name": "iteratorVariable",
        "type": "String",
        "isAttr": true
      }
    ],
    "isAbstract": true
  },
  {
    "name": "For",
    "superClass": [
      "Iterator"
    ],
    "properties": [
      {
        "name": "return",
        "type": "ChildExpression"
      }
    ]
  },
  {
    "name": "Quantified",
    "superClass": [
      "Iterator"
    ],
    "properties": [
      {
        "name": "satisfies",
        "type": "ChildExpression"
      }
    ],
    "isAbstract": true
  },
  {
    "name": "Conditional",
    "superClass": [
      "Expression"
    ],
    "properties": [
      {
        "name": "if",
        "type": "ChildExpression"
      },
      {
        "name": "then",
        "type": "ChildExpression"
      },
      {
        "name": "else",
        "type": "ChildExpression"
      }
    ]
  },
  {
    "name": "Filter",
    "superClass": [
      "Expression"
    ],
    "properties": [
      {
        "name": "in",
        "type": "ChildExpression"
      },
      {
        "name": "match",
        "type": "ChildExpression"
      }
    ]
  },
  {
    "name": "Some",
    "superClass": [
      "Quantified"
    ],
    "properties": []
  },
  {
    "name": "Every",
    "superClass": [
      "Quantified"
    ],
    "properties": []
  },
  {
    "name": "Element",
    "superClass": [],
    "properties": [],
    "isAbstract": true
  },
  {
    "name": "ExtensionElements",
    "superClass": [
      "Element"
    ],
    "properties": [
      {
        "name": "values",
        "type": "Element",
        "isMany": true
      }
    ]
  },
  {
    "name": "ExtensionAttribute",
    "superClass": [
      "Element"
    ],
    "properties": [
      {
        "name": "name",
        "type": "String",
        "isAttr": true
      },
      {
        "name": "value",
        "type": "String",
        "isAttr": true
      }
    ]
  }
];

export const SPEC_TYPE_BY_NAME: Readonly<Record<string, SpecType>> = Object.fromEntries(
  SPEC_TYPES.map((t) => [t.name, t]),
);

/** DMN 1.5 语义元模型（`https://www.omg.org/spec/DMN/20230324/MODEL/`） 枚举（来自 XSD simpleType） */
export const SPEC_ENUMS: Readonly<Record<string, readonly string[]>> = 
{
  "HitPolicy": [
    "UNIQUE",
    "FIRST",
    "PRIORITY",
    "ANY",
    "COLLECT",
    "RULE ORDER",
    "OUTPUT ORDER"
  ],
  "BuiltinAggregator": [
    "SUM",
    "COUNT",
    "MIN",
    "MAX"
  ],
  "DecisionTableOrientation": [
    "Rule-as-Row",
    "Rule-as-Column",
    "CrossTable"
  ],
  "AssociationDirection": [
    "None",
    "One",
    "Both"
  ],
  "FunctionKind": [
    "FEEL",
    "Java",
    "PMML"
  ]
};

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
  "definitions": "Definitions",
  "import": "Import",
  "elementCollection": "ElementCollection",
  "decision": "Decision",
  "performanceIndicator": "PerformanceIndicator",
  "organizationUnit": "OrganisationalUnit",
  "businessKnowledgeModel": "BusinessKnowledgeModel",
  "inputData": "InputData",
  "knowledgeSource": "KnowledgeSource",
  "informationRequirement": "InformationRequirement",
  "knowledgeRequirement": "KnowledgeRequirement",
  "authorityRequirement": "AuthorityRequirement",
  "itemDefinition": "ItemDefinition",
  "functionItem": "FunctionItem",
  "literalExpression": "LiteralExpression",
  "invocation": "Invocation",
  "informationItem": "InformationItem",
  "decisionTable": "DecisionTable",
  "group": "Group",
  "textAnnotation": "TextAnnotation",
  "association": "Association",
  "context": "Context",
  "contextEntry": "ContextEntry",
  "functionDefinition": "FunctionDefinition",
  "relation": "Relation",
  "list": "List",
  "decisionService": "DecisionService",
  "for": "For",
  "every": "Every",
  "some": "Some",
  "conditional": "Conditional",
  "filter": "Filter"
};
