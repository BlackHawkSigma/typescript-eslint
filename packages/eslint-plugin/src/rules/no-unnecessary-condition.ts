import type { TSESTree } from '@typescript-eslint/utils';
import { AST_NODE_TYPES, AST_TOKEN_TYPES } from '@typescript-eslint/utils';
import * as tsutils from 'ts-api-utils';
import * as ts from 'typescript';

import {
  createRule,
  getConstrainedTypeAtLocation,
  getParserServices,
  getTypeName,
  getTypeOfPropertyOfName,
  isIdentifier,
  isNullableType,
  isTypeAnyType,
  isTypeFlagSet,
  isTypeUnknownType,
  nullThrows,
  NullThrowsReasons,
} from '../util';

// Truthiness utilities
// #region
const isTruthyLiteral = (type: ts.Type): boolean =>
  tsutils.isTrueLiteralType(type) ||
  //  || type.
  (type.isLiteral() && !!type.value);

const isPossiblyFalsy = (type: ts.Type): boolean =>
  tsutils
    .unionTypeParts(type)
    // Intersections like `string & {}` can also be possibly falsy,
    // requiring us to look into the intersection.
    .flatMap(type => tsutils.intersectionTypeParts(type))
    // PossiblyFalsy flag includes literal values, so exclude ones that
    // are definitely truthy
    .filter(t => !isTruthyLiteral(t))
    .some(type => isTypeFlagSet(type, ts.TypeFlags.PossiblyFalsy));

const isPossiblyTruthy = (type: ts.Type): boolean =>
  tsutils
    .unionTypeParts(type)
    .map(type => tsutils.intersectionTypeParts(type))
    .some(intersectionParts =>
      // It is possible to define intersections that are always falsy,
      // like `"" & { __brand: string }`.
      intersectionParts.every(type => !tsutils.isFalsyType(type)),
    );

// Nullish utilities
const nullishFlag = ts.TypeFlags.Undefined | ts.TypeFlags.Null;
const isNullishType = (type: ts.Type): boolean =>
  isTypeFlagSet(type, nullishFlag);

const isPossiblyNullish = (type: ts.Type): boolean =>
  tsutils.unionTypeParts(type).some(isNullishType);

const isAlwaysNullish = (type: ts.Type): boolean =>
  tsutils.unionTypeParts(type).every(isNullishType);

// isLiteralType only covers numbers and strings, this is a more exhaustive check.
const isLiteral = (type: ts.Type): boolean =>
  tsutils.isBooleanLiteralType(type) ||
  type.flags === ts.TypeFlags.Undefined ||
  type.flags === ts.TypeFlags.Null ||
  type.flags === ts.TypeFlags.Void ||
  type.isLiteral();
// #endregion

export type Options = [
  {
    allowConstantLoopConditions?: boolean;
    allowRuleToRunWithoutStrictNullChecksIKnowWhatIAmDoing?: boolean;
  },
];

export type MessageId =
  | 'alwaysFalsy'
  | 'alwaysFalsyFunc'
  | 'alwaysNullish'
  | 'alwaysTruthy'
  | 'alwaysTruthyFunc'
  | 'literalBooleanExpression'
  | 'never'
  | 'neverNullish'
  | 'neverOptionalChain'
  | 'noOverlapBooleanExpression'
  | 'noStrictNullCheck';

export default createRule<Options, MessageId>({
  name: 'no-unnecessary-condition',
  meta: {
    type: 'suggestion',
    docs: {
      description:
        'Disallow conditionals where the type is always truthy or always falsy',
      recommended: 'strict',
      requiresTypeChecking: true,
    },
    schema: [
      {
        type: 'object',
        properties: {
          allowConstantLoopConditions: {
            description:
              'Whether to ignore constant loop conditions, such as `while (true)`.',
            type: 'boolean',
          },
          allowRuleToRunWithoutStrictNullChecksIKnowWhatIAmDoing: {
            description:
              'Whether to not error when running with a tsconfig that has strictNullChecks turned.',
            type: 'boolean',
          },
        },
        additionalProperties: false,
      },
    ],
    fixable: 'code',
    messages: {
      alwaysTruthy: 'Unnecessary conditional, value is always truthy.',
      alwaysFalsy: 'Unnecessary conditional, value is always falsy.',
      alwaysTruthyFunc:
        'This callback should return a conditional, but return is always truthy.',
      alwaysFalsyFunc:
        'This callback should return a conditional, but return is always falsy.',
      neverNullish:
        'Unnecessary conditional, expected left-hand side of `??` operator to be possibly null or undefined.',
      alwaysNullish:
        'Unnecessary conditional, left-hand side of `??` operator is always `null` or `undefined`.',
      literalBooleanExpression:
        'Unnecessary conditional, both sides of the expression are literal values.',
      noOverlapBooleanExpression:
        'Unnecessary conditional, the types have no overlap.',
      never: 'Unnecessary conditional, value is `never`.',
      neverOptionalChain: 'Unnecessary optional chain on a non-nullish value.',
      noStrictNullCheck:
        'This rule requires the `strictNullChecks` compiler option to be turned on to function correctly.',
    },
  },
  defaultOptions: [
    {
      allowConstantLoopConditions: false,
      allowRuleToRunWithoutStrictNullChecksIKnowWhatIAmDoing: false,
    },
  ],
  create(
    context,
    [
      {
        allowConstantLoopConditions,
        allowRuleToRunWithoutStrictNullChecksIKnowWhatIAmDoing,
      },
    ],
  ) {
    const services = getParserServices(context);
    const checker = services.program.getTypeChecker();

    const compilerOptions = services.program.getCompilerOptions();
    const isStrictNullChecks = tsutils.isStrictCompilerOptionEnabled(
      compilerOptions,
      'strictNullChecks',
    );

    if (
      !isStrictNullChecks &&
      allowRuleToRunWithoutStrictNullChecksIKnowWhatIAmDoing !== true
    ) {
      context.report({
        loc: {
          start: { line: 0, column: 0 },
          end: { line: 0, column: 0 },
        },
        messageId: 'noStrictNullCheck',
      });
    }

    function nodeIsArrayType(node: TSESTree.Expression): boolean {
      const nodeType = getConstrainedTypeAtLocation(services, node);
      return checker.isArrayType(nodeType);
    }
    function nodeIsTupleType(node: TSESTree.Expression): boolean {
      const nodeType = getConstrainedTypeAtLocation(services, node);
      return checker.isTupleType(nodeType);
    }

    function isArrayIndexExpression(node: TSESTree.Expression): boolean {
      return (
        // Is an index signature
        node.type === AST_NODE_TYPES.MemberExpression &&
        node.computed &&
        // ...into an array type
        (nodeIsArrayType(node.object) ||
          // ... or a tuple type
          (nodeIsTupleType(node.object) &&
            // Exception: literal index into a tuple - will have a sound type
            node.property.type !== AST_NODE_TYPES.Literal))
      );
    }

    function isNullableMemberExpression(
      node: TSESTree.MemberExpression,
    ): boolean {
      const objectType = services.getTypeAtLocation(node.object);
      if (node.computed) {
        const propertyType = services.getTypeAtLocation(node.property);
        return isNullablePropertyType(objectType, propertyType);
      }
      const property = node.property;

      if (property.type === AST_NODE_TYPES.Identifier) {
        const propertyType = objectType.getProperty(property.name);
        if (
          propertyType &&
          tsutils.isSymbolFlagSet(propertyType, ts.SymbolFlags.Optional)
        ) {
          return true;
        }
      }
      return false;
    }

    /**
     * Checks if a conditional node is necessary:
     * if the type of the node is always true or always false, it's not necessary.
     */
    function checkNode(
      node: TSESTree.Expression,
      isUnaryNotArgument = false,
    ): void {
      // Check if the node is Unary Negation expression and handle it
      if (
        node.type === AST_NODE_TYPES.UnaryExpression &&
        node.operator === '!'
      ) {
        return checkNode(node.argument, true);
      }

      // Since typescript array index signature types don't represent the
      //  possibility of out-of-bounds access, if we're indexing into an array
      //  just skip the check, to avoid false positives
      if (isArrayIndexExpression(node)) {
        return;
      }

      // When checking logical expressions, only check the right side
      //  as the left side has been checked by checkLogicalExpressionForUnnecessaryConditionals
      //
      // Unless the node is nullish coalescing, as it's common to use patterns like `nullBool ?? true` to to strict
      //  boolean checks if we inspect the right here, it'll usually be a constant condition on purpose.
      // In this case it's better to inspect the type of the expression as a whole.
      if (
        node.type === AST_NODE_TYPES.LogicalExpression &&
        node.operator !== '??'
      ) {
        return checkNode(node.right);
      }

      const type = getConstrainedTypeAtLocation(services, node);

      // Conditional is always necessary if it involves:
      //    `any` or `unknown` or a naked type variable
      if (
        tsutils
          .unionTypeParts(type)
          .some(
            part =>
              isTypeAnyType(part) ||
              isTypeUnknownType(part) ||
              isTypeFlagSet(part, ts.TypeFlags.TypeVariable),
          )
      ) {
        return;
      }
      let messageId: MessageId | null = null;

      if (isTypeFlagSet(type, ts.TypeFlags.Never)) {
        messageId = 'never';
      } else if (!isPossiblyTruthy(type)) {
        messageId = !isUnaryNotArgument ? 'alwaysFalsy' : 'alwaysTruthy';
      } else if (!isPossiblyFalsy(type)) {
        messageId = !isUnaryNotArgument ? 'alwaysTruthy' : 'alwaysFalsy';
      }

      if (messageId) {
        context.report({ node, messageId });
      }
    }

    function checkNodeForNullish(node: TSESTree.Expression): void {
      const type = getConstrainedTypeAtLocation(services, node);

      // Conditional is always necessary if it involves `any`, `unknown` or a naked type parameter
      if (
        isTypeFlagSet(
          type,
          ts.TypeFlags.Any |
            ts.TypeFlags.Unknown |
            ts.TypeFlags.TypeParameter |
            ts.TypeFlags.TypeVariable,
        )
      ) {
        return;
      }

      let messageId: MessageId | null = null;
      if (isTypeFlagSet(type, ts.TypeFlags.Never)) {
        messageId = 'never';
      } else if (
        !isPossiblyNullish(type) &&
        !(
          node.type === AST_NODE_TYPES.MemberExpression &&
          isNullableMemberExpression(node)
        )
      ) {
        // Since typescript array index signature types don't represent the
        //  possibility of out-of-bounds access, if we're indexing into an array
        //  just skip the check, to avoid false positives
        if (
          !isArrayIndexExpression(node) &&
          !(
            node.type === AST_NODE_TYPES.ChainExpression &&
            node.expression.type !== AST_NODE_TYPES.TSNonNullExpression &&
            optionChainContainsOptionArrayIndex(node.expression)
          )
        ) {
          messageId = 'neverNullish';
        }
      } else if (isAlwaysNullish(type)) {
        messageId = 'alwaysNullish';
      }

      if (messageId) {
        context.report({ node, messageId });
      }
    }

    /**
     * Checks that a binary expression is necessarily conditional, reports otherwise.
     * If both sides of the binary expression are literal values, it's not a necessary condition.
     *
     * NOTE: It's also unnecessary if the types that don't overlap at all
     *    but that case is handled by the Typescript compiler itself.
     *    Known exceptions:
     *      - https://github.com/microsoft/TypeScript/issues/32627
     *      - https://github.com/microsoft/TypeScript/issues/37160 (handled)
     */
    const BOOL_OPERATORS = new Set([
      '<',
      '>',
      '<=',
      '>=',
      '==',
      '===',
      '!=',
      '!==',
    ]);
    function checkIfBinaryExpressionIsNecessaryConditional(
      node: TSESTree.BinaryExpression,
    ): void {
      if (!BOOL_OPERATORS.has(node.operator)) {
        return;
      }
      const leftType = getConstrainedTypeAtLocation(services, node.left);
      const rightType = getConstrainedTypeAtLocation(services, node.right);
      if (isLiteral(leftType) && isLiteral(rightType)) {
        context.report({ node, messageId: 'literalBooleanExpression' });
        return;
      }
      // Workaround for https://github.com/microsoft/TypeScript/issues/37160
      if (isStrictNullChecks) {
        const UNDEFINED = ts.TypeFlags.Undefined;
        const NULL = ts.TypeFlags.Null;
        const VOID = ts.TypeFlags.Void;
        const isComparable = (type: ts.Type, flag: ts.TypeFlags): boolean => {
          // Allow comparison to `any`, `unknown` or a naked type parameter.
          flag |=
            ts.TypeFlags.Any |
            ts.TypeFlags.Unknown |
            ts.TypeFlags.TypeParameter |
            ts.TypeFlags.TypeVariable;

          // Allow loose comparison to nullish values.
          if (node.operator === '==' || node.operator === '!=') {
            flag |= NULL | UNDEFINED | VOID;
          }

          return isTypeFlagSet(type, flag);
        };

        if (
          (leftType.flags === UNDEFINED &&
            !isComparable(rightType, UNDEFINED | VOID)) ||
          (rightType.flags === UNDEFINED &&
            !isComparable(leftType, UNDEFINED | VOID)) ||
          (leftType.flags === NULL && !isComparable(rightType, NULL)) ||
          (rightType.flags === NULL && !isComparable(leftType, NULL))
        ) {
          context.report({ node, messageId: 'noOverlapBooleanExpression' });
          return;
        }
      }
    }

    /**
     * Checks that a logical expression contains a boolean, reports otherwise.
     */
    function checkLogicalExpressionForUnnecessaryConditionals(
      node: TSESTree.LogicalExpression,
    ): void {
      if (node.operator === '??') {
        checkNodeForNullish(node.left);
        return;
      }
      // Only checks the left side, since the right side might not be "conditional" at all.
      // The right side will be checked if the LogicalExpression is used in a conditional context
      checkNode(node.left);
    }

    /**
     * Checks that a testable expression of a loop is necessarily conditional, reports otherwise.
     */
    function checkIfLoopIsNecessaryConditional(
      node:
        | TSESTree.DoWhileStatement
        | TSESTree.ForStatement
        | TSESTree.WhileStatement,
    ): void {
      if (node.test == null) {
        // e.g. `for(;;)`
        return;
      }

      /**
       * Allow:
       *   while (true) {}
       *   for (;true;) {}
       *   do {} while (true)
       */
      if (
        allowConstantLoopConditions &&
        tsutils.isTrueLiteralType(
          getConstrainedTypeAtLocation(services, node.test),
        )
      ) {
        return;
      }

      checkNode(node.test);
    }

    const ARRAY_PREDICATE_FUNCTIONS = new Set([
      'filter',
      'find',
      'some',
      'every',
    ]);
    function isArrayPredicateFunction(node: TSESTree.CallExpression): boolean {
      const { callee } = node;
      return (
        // looks like `something.filter` or `something.find`
        callee.type === AST_NODE_TYPES.MemberExpression &&
        callee.property.type === AST_NODE_TYPES.Identifier &&
        ARRAY_PREDICATE_FUNCTIONS.has(callee.property.name) &&
        // and the left-hand side is an array, according to the types
        (nodeIsArrayType(callee.object) || nodeIsTupleType(callee.object))
      );
    }
    function checkCallExpression(node: TSESTree.CallExpression): void {
      // If this is something like arr.filter(x => /*condition*/), check `condition`
      if (isArrayPredicateFunction(node) && node.arguments.length) {
        const callback = node.arguments[0];
        // Inline defined functions
        if (
          callback.type === AST_NODE_TYPES.ArrowFunctionExpression ||
          callback.type === AST_NODE_TYPES.FunctionExpression
        ) {
          // Two special cases, where we can directly check the node that's returned:
          // () => something
          if (callback.body.type !== AST_NODE_TYPES.BlockStatement) {
            return checkNode(callback.body);
          }
          // () => { return something; }
          const callbackBody = callback.body.body;
          if (
            callbackBody.length === 1 &&
            callbackBody[0].type === AST_NODE_TYPES.ReturnStatement &&
            callbackBody[0].argument
          ) {
            return checkNode(callbackBody[0].argument);
          }
          // Potential enhancement: could use code-path analysis to check
          //   any function with a single return statement
          // (Value to complexity ratio is dubious however)
        }
        // Otherwise just do type analysis on the function as a whole.
        const returnTypes = tsutils
          .getCallSignaturesOfType(
            getConstrainedTypeAtLocation(services, callback),
          )
          .map(sig => sig.getReturnType());
        /* istanbul ignore if */ if (returnTypes.length === 0) {
          // Not a callable function
          return;
        }
        // Predicate is always necessary if it involves `any` or `unknown`
        if (returnTypes.some(t => isTypeAnyType(t) || isTypeUnknownType(t))) {
          return;
        }
        if (!returnTypes.some(isPossiblyFalsy)) {
          return context.report({
            node: callback,
            messageId: 'alwaysTruthyFunc',
          });
        }
        if (!returnTypes.some(isPossiblyTruthy)) {
          return context.report({
            node: callback,
            messageId: 'alwaysFalsyFunc',
          });
        }
      }
    }

    // Recursively searches an optional chain for an array index expression
    //  Has to search the entire chain, because an array index will "infect" the rest of the types
    //  Example:
    //  ```
    //  [{x: {y: "z"} }][n] // type is {x: {y: "z"}}
    //    ?.x // type is {y: "z"}
    //    ?.y // This access is considered "unnecessary" according to the types
    //  ```
    function optionChainContainsOptionArrayIndex(
      node: TSESTree.CallExpression | TSESTree.MemberExpression,
    ): boolean {
      const lhsNode =
        node.type === AST_NODE_TYPES.CallExpression ? node.callee : node.object;
      if (node.optional && isArrayIndexExpression(lhsNode)) {
        return true;
      }
      if (
        lhsNode.type === AST_NODE_TYPES.MemberExpression ||
        lhsNode.type === AST_NODE_TYPES.CallExpression
      ) {
        return optionChainContainsOptionArrayIndex(lhsNode);
      }
      return false;
    }

    function isNullablePropertyType(
      objType: ts.Type,
      propertyType: ts.Type,
    ): boolean {
      if (propertyType.isUnion()) {
        return propertyType.types.some(type =>
          isNullablePropertyType(objType, type),
        );
      }
      if (propertyType.isNumberLiteral() || propertyType.isStringLiteral()) {
        const propType = getTypeOfPropertyOfName(
          checker,
          objType,
          propertyType.value.toString(),
        );
        if (propType) {
          return isNullableType(propType);
        }
      }
      const typeName = getTypeName(checker, propertyType);
      return !!checker
        .getIndexInfosOfType(objType)
        .find(info => getTypeName(checker, info.keyType) === typeName);
    }

    // Checks whether a member expression is nullable or not regardless of it's previous node.
    //  Example:
    //  ```
    //  // 'bar' is nullable if 'foo' is null.
    //  // but this function checks regardless of 'foo' type, so returns 'true'.
    //  declare const foo: { bar : { baz: string } } | null
    //  foo?.bar;
    //  ```
    function isMemberExpressionNullableOriginFromObject(
      node: TSESTree.MemberExpression,
    ): boolean {
      const prevType = getConstrainedTypeAtLocation(services, node.object);
      const property = node.property;
      if (prevType.isUnion() && isIdentifier(property)) {
        const isOwnNullable = prevType.types.some(type => {
          if (node.computed) {
            const propertyType = getConstrainedTypeAtLocation(
              services,
              node.property,
            );
            return isNullablePropertyType(type, propertyType);
          }
          const propType = getTypeOfPropertyOfName(
            checker,
            type,
            property.name,
          );

          if (propType) {
            return isNullableType(propType);
          }

          return !!checker.getIndexInfoOfType(type, ts.IndexKind.String);
        });
        return !isOwnNullable && isNullableType(prevType);
      }
      return false;
    }

    function isCallExpressionNullableOriginFromCallee(
      node: TSESTree.CallExpression,
    ): boolean {
      const prevType = getConstrainedTypeAtLocation(services, node.callee);

      if (prevType.isUnion()) {
        const isOwnNullable = prevType.types.some(type => {
          const signatures = type.getCallSignatures();
          return signatures.some(sig =>
            isNullableType(sig.getReturnType(), { allowUndefined: true }),
          );
        });
        return (
          !isOwnNullable && isNullableType(prevType, { allowUndefined: true })
        );
      }

      return false;
    }

    function isOptionableExpression(node: TSESTree.Expression): boolean {
      const type = getConstrainedTypeAtLocation(services, node);
      const isOwnNullable =
        node.type === AST_NODE_TYPES.MemberExpression
          ? !isMemberExpressionNullableOriginFromObject(node)
          : node.type === AST_NODE_TYPES.CallExpression
            ? !isCallExpressionNullableOriginFromCallee(node)
            : true;

      const possiblyVoid = isTypeFlagSet(type, ts.TypeFlags.Void);
      return (
        isTypeFlagSet(type, ts.TypeFlags.Any | ts.TypeFlags.Unknown) ||
        (isOwnNullable && (isNullableType(type) || possiblyVoid))
      );
    }

    function checkOptionalChain(
      node: TSESTree.CallExpression | TSESTree.MemberExpression,
      beforeOperator: TSESTree.Node,
      fix: '.' | '',
    ): void {
      // We only care if this step in the chain is optional. If just descend
      // from an optional chain, then that's fine.
      if (!node.optional) {
        return;
      }

      // Since typescript array index signature types don't represent the
      //  possibility of out-of-bounds access, if we're indexing into an array
      //  just skip the check, to avoid false positives
      if (optionChainContainsOptionArrayIndex(node)) {
        return;
      }

      const nodeToCheck =
        node.type === AST_NODE_TYPES.CallExpression ? node.callee : node.object;

      if (isOptionableExpression(nodeToCheck)) {
        return;
      }

      const questionDotOperator = nullThrows(
        context.sourceCode.getTokenAfter(
          beforeOperator,
          token =>
            token.type === AST_TOKEN_TYPES.Punctuator && token.value === '?.',
        ),
        NullThrowsReasons.MissingToken('operator', node.type),
      );

      context.report({
        node,
        loc: questionDotOperator.loc,
        messageId: 'neverOptionalChain',
        fix(fixer) {
          return fixer.replaceText(questionDotOperator, fix);
        },
      });
    }

    function checkOptionalMemberExpression(
      node: TSESTree.MemberExpression,
    ): void {
      checkOptionalChain(node, node.object, node.computed ? '' : '.');
    }

    function checkOptionalCallExpression(node: TSESTree.CallExpression): void {
      checkOptionalChain(node, node.callee, '');
    }

    function checkAssignmentExpression(
      node: TSESTree.AssignmentExpression,
    ): void {
      // Similar to checkLogicalExpressionForUnnecessaryConditionals, since
      // a ||= b is equivalent to a || (a = b)
      if (['||=', '&&='].includes(node.operator)) {
        checkNode(node.left);
      } else if (node.operator === '??=') {
        checkNodeForNullish(node.left);
      }
    }

    return {
      AssignmentExpression: checkAssignmentExpression,
      BinaryExpression: checkIfBinaryExpressionIsNecessaryConditional,
      CallExpression: checkCallExpression,
      ConditionalExpression: (node): void => checkNode(node.test),
      DoWhileStatement: checkIfLoopIsNecessaryConditional,
      ForStatement: checkIfLoopIsNecessaryConditional,
      IfStatement: (node): void => checkNode(node.test),
      LogicalExpression: checkLogicalExpressionForUnnecessaryConditionals,
      WhileStatement: checkIfLoopIsNecessaryConditional,
      'MemberExpression[optional = true]': checkOptionalMemberExpression,
      'CallExpression[optional = true]': checkOptionalCallExpression,
    };
  },
});
