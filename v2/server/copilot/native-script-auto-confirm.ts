import * as ts from "typescript";

const MAX_AUTO_CONFIRM_SCRIPT_LENGTH = 12_000;
const MAX_INSERTED_VERTICES = 6;
const MAX_INSERTED_EDGES = 8;
const MAX_TOTAL_INSERTIONS = 12;

const READ_ONLY_CALLS = new Set([
  "graph.getDefaultParent",
  "graph.convertValueToString",
  "graph.view.validate",
  "graph.view.getState",
  "model.getCell",
  "model.getGeometry",
  "model.getStyle",
  "model.getTerminal"
]);
const TRANSACTION_CALLS = new Set(["model.beginUpdate", "model.endUpdate"]);
const INSERTION_CALLS = new Set(["graph.insertVertex", "graph.insertEdge"]);
const SAFE_CALLS = new Set([...READ_ONLY_CALLS, ...TRANSACTION_CALLS, ...INSERTION_CALLS, "graph.refresh"]);
const DANGEROUS_PROPERTIES = new Set([
  "constructor", "__proto__", "prototype", "caller", "callee", "arguments",
  "__defineGetter__", "__defineSetter__"
]);
const NATIVE_BINDINGS = new Set(["graph", "model", "ui", "editor"]);
const SAFE_BINARY_OPERATORS = new Set([
  ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.EqualsEqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken,
  ts.SyntaxKind.LessThanToken, ts.SyntaxKind.LessThanEqualsToken,
  ts.SyntaxKind.GreaterThanToken, ts.SyntaxKind.GreaterThanEqualsToken,
  ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.BarBarToken,
  ts.SyntaxKind.QuestionQuestionToken,
  ts.SyntaxKind.PlusToken, ts.SyntaxKind.MinusToken,
  ts.SyntaxKind.AsteriskToken, ts.SyntaxKind.SlashToken, ts.SyntaxKind.PercentToken
]);

function pathOf(expression: ts.Expression): string | null {
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression) && !expression.questionDotToken) {
    const parent = pathOf(expression.expression);
    return parent ? parent + "." + expression.name.text : null;
  }
  return null;
}

function visitTree(node: ts.Node, visitor: (node: ts.Node) => void): void {
  visitor(node);
  ts.forEachChild(node, child => visitTree(child, visitor));
}

function isIdentifierBinding(node: ts.Identifier): boolean {
  const parent = node.parent;
  return (ts.isVariableDeclaration(parent) && parent.name === node) ||
    (ts.isParameter(parent) && parent.name === node) ||
    (ts.isFunctionDeclaration(parent) && parent.name === node);
}

function isPropertyKey(node: ts.Identifier): boolean {
  const parent = node.parent;
  return (ts.isPropertyAccessExpression(parent) && parent.name === node) ||
    (ts.isPropertyAssignment(parent) && parent.name === node && !ts.isComputedPropertyName(parent.name)) ||
    (ts.isMethodDeclaration(parent) && parent.name === node) ||
    (ts.isGetAccessorDeclaration(parent) && parent.name === node) ||
    (ts.isSetAccessorDeclaration(parent) && parent.name === node);
}

function directExpressionStatement(expression: ts.Expression): ts.ExpressionStatement | null {
  let candidate: ts.Node = expression;
  if (ts.isBinaryExpression(expression.parent) && expression.parent.right === expression &&
      expression.parent.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isIdentifier(expression.parent.left)) {
    candidate = expression.parent;
  }
  const parent = candidate.parent;
  return ts.isExpressionStatement(parent) && parent.expression === candidate ? parent : null;
}

function containsIdentifier(expression: ts.Node, name: string): boolean {
  let found = false;
  visitTree(expression, node => {
    if (ts.isIdentifier(node) && node.text === name && !isPropertyKey(node)) found = true;
  });
  return found;
}

function isBoundedReadLoop(
  statement: ts.ForStatement,
  locals: Set<string>,
  arrayNames: Set<string>
): string | null {
  const initializer = statement.initializer;
  if (!initializer || !ts.isVariableDeclarationList(initializer) || initializer.declarations.length !== 1) return null;
  const declaration = initializer.declarations[0];
  if (!ts.isIdentifier(declaration.name) || !declaration.initializer ||
      !ts.isNumericLiteral(declaration.initializer) || Number(declaration.initializer.text) !== 0) return null;
  const index = declaration.name.text;
  const condition = statement.condition;
  if (!condition || !ts.isBinaryExpression(condition) ||
      condition.operatorToken.kind !== ts.SyntaxKind.LessThanToken ||
      !ts.isIdentifier(condition.left) || condition.left.text !== index ||
      !ts.isPropertyAccessExpression(condition.right) ||
      condition.right.name.text !== "length" || condition.right.questionDotToken) return null;
  const collectionPath = pathOf(condition.right.expression);
  if (!collectionPath) return null;
  const root = collectionPath.split(".")[0];
  if (!locals.has(root)) return null;
  const isPointList = collectionPath.endsWith(".absolutePoints");
  const isKnownLocalArray = ts.isIdentifier(condition.right.expression) && arrayNames.has(condition.right.expression.text);
  if (!isPointList && !isKnownLocalArray) return null;
  const incrementor = statement.incrementor;
  if (!incrementor || !ts.isPostfixUnaryExpression(incrementor) ||
      incrementor.operator !== ts.SyntaxKind.PlusPlusToken ||
      !ts.isIdentifier(incrementor.operand) || incrementor.operand.text !== index) return null;
  return index;
}

function forbiddenSyntax(node: ts.Node): boolean {
  return ts.isArrowFunction(node) || ts.isFunctionExpression(node) ||
    ts.isClassDeclaration(node) || ts.isClassExpression(node) ||
    ts.isMethodDeclaration(node) || ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node) ||
    ts.isAwaitExpression(node) || ts.isYieldExpression(node) ||
    ts.isTaggedTemplateExpression(node) || ts.isTemplateExpression(node) ||
    ts.isDeleteExpression(node) || ts.isWithStatement(node) ||
    ts.isForInStatement(node) || ts.isForOfStatement(node) ||
    ts.isWhileStatement(node) || ts.isDoStatement(node) ||
    ts.isSpreadElement(node) || ts.isSpreadAssignment(node) ||
    ts.isImportTypeNode(node);
}

function allowedStatement(node: ts.Statement): boolean {
  return ts.isBlock(node) || ts.isVariableStatement(node) ||
    ts.isExpressionStatement(node) || ts.isIfStatement(node) ||
    ts.isTryStatement(node) || ts.isReturnStatement(node) ||
    ts.isThrowStatement(node) || ts.isForStatement(node) ||
    ts.isFunctionDeclaration(node) || ts.isEmptyStatement(node);
}

function hasOnlySimplePropertyName(node: ts.PropertyName): boolean {
  if (ts.isComputedPropertyName(node)) return false;
  const name = ts.isIdentifier(node) || ts.isStringLiteralLike(node) || ts.isNumericLiteral(node)
    ? node.text : "";
  return Boolean(name) && !DANGEROUS_PROPERTIES.has(name);
}

function callArityAllowed(path: string, count: number): boolean {
  switch (path) {
    case "graph.getDefaultParent":
    case "graph.refresh":
    case "graph.view.validate":
    case "model.beginUpdate":
    case "model.endUpdate":
      return count === 0;
    case "graph.insertVertex":
      return count >= 7 && count <= 8;
    case "graph.insertEdge":
      return count >= 5 && count <= 6;
    case "graph.convertValueToString":
    case "graph.view.getState":
    case "model.getCell":
    case "model.getGeometry":
    case "model.getStyle":
      return count === 1;
    case "model.getTerminal":
      return count === 2;
    default:
      return false;
  }
}

/**
 * Conservative AST gate for scripts that only add new native cells.
 * Any syntax or API call not explicitly reviewed here fails closed and asks for confirmation.
 */
export function isAutoConfirmableCreationScript(script: string): boolean {
  if (!script.trim() || script.length > MAX_AUTO_CONFIRM_SCRIPT_LENGTH) return false;

  const source = ts.createSourceFile(
    "studio-native-script.js",
    "function __studioNativeScript() {\n" + script + "\n}",
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS
  );
  const firstStatement = source.statements[0];
  if (source.parseDiagnostics.length !== 0 || source.statements.length !== 1 ||
      !firstStatement || !ts.isFunctionDeclaration(firstStatement)) return false;
  const wrapper = firstStatement;
  if (!wrapper.body) return false;
  const body = wrapper.body;
  const locals = new Set<string>();
  const helpers = new Set<string>();
  const arrayNames = new Set<string>();
  const parentVariables = new Set<string>();
  const helperNodes: ts.FunctionDeclaration[] = [];
  let valid = true;

  visitTree(body, node => {
    if (ts.isVariableDeclaration(node)) {
      if (!ts.isIdentifier(node.name)) valid = false;
      else {
        if (NATIVE_BINDINGS.has(node.name.text)) valid = false;
        locals.add(node.name.text);
        if (node.initializer && ts.isArrayLiteralExpression(node.initializer) && node.initializer.elements.length === 0) {
          arrayNames.add(node.name.text);
        }
        if (node.initializer && ts.isCallExpression(node.initializer) &&
            pathOf(node.initializer.expression) === "graph.getDefaultParent" &&
            node.initializer.arguments.length === 0) {
          parentVariables.add(node.name.text);
        }
      }
    }
    if (ts.isFunctionDeclaration(node) && node !== wrapper) {
      if (node.parent !== body || !node.name || !node.body || node.asteriskToken ||
          node.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.AsyncKeyword)) {
        valid = false;
      } else {
        if (NATIVE_BINDINGS.has(node.name.text) || DANGEROUS_PROPERTIES.has(node.name.text)) valid = false;
        helpers.add(node.name.text);
        locals.add(node.name.text);
        helperNodes.push(node);
        for (const parameter of node.parameters) {
          if (!ts.isIdentifier(parameter.name) || parameter.initializer || parameter.dotDotToken) valid = false;
          else {
            if (NATIVE_BINDINGS.has(parameter.name.text)) valid = false;
            locals.add(parameter.name.text);
          }
        }
      }
    }
  });
  if (!valid) return false;

  const loopIndices = new Set<string>();
  const loops: ts.ForStatement[] = [];
  visitTree(body, node => {
    if (ts.isForStatement(node)) {
      const index = isBoundedReadLoop(node, locals, arrayNames);
      if (!index) valid = false;
      else loopIndices.add(index);
      loops.push(node);
    }
  });
  if (!valid) return false;

  const insertionCalls: Array<{ node: ts.CallExpression; path: string }> = [];
  const beginCalls: ts.CallExpression[] = [];
  const endCalls: ts.CallExpression[] = [];
  const refreshCalls: ts.CallExpression[] = [];
  const insertedResultNames = new Set<string>();
  const insertCounts = { vertices: 0, edges: 0 };
  const loopAncestors = (node: ts.Node): boolean => {
    for (let current = node.parent; current && current !== wrapper; current = current.parent) {
      if (ts.isForStatement(current)) return true;
    }
    return false;
  };
  const helperAncestor = (node: ts.Node): ts.FunctionDeclaration | null => {
    for (let current = node.parent; current && current !== wrapper; current = current.parent) {
      if (ts.isFunctionDeclaration(current) && current !== wrapper) return current;
    }
    return null;
  };

  visitTree(body, node => {
    if (!valid) return;
    if (forbiddenSyntax(node)) { valid = false; return; }

    if (ts.isStatement(node) && !allowedStatement(node)) { valid = false; return; }

    if (ts.isTryStatement(node) && (node.catchClause || !node.finallyBlock)) {
      valid = false;
      return;
    }

    if (ts.isPropertyAccessExpression(node)) {
      if (node.questionDotToken || DANGEROUS_PROPERTIES.has(node.name.text)) {
        valid = false;
        return;
      }
    }
    if (ts.isElementAccessExpression(node)) {
      if (node.questionDotToken || !node.argumentExpression) { valid = false; return; }
      const base = pathOf(node.expression);
      const safePointAccess = Boolean(base?.endsWith(".absolutePoints") &&
        ts.isIdentifier(node.argumentExpression) && loopIndices.has(node.argumentExpression.text));
      if (!safePointAccess) { valid = false; return; }
      if (ts.isStringLiteralLike(node.argumentExpression) && DANGEROUS_PROPERTIES.has(node.argumentExpression.text)) {
        valid = false;
        return;
      }
    }
    if (ts.isPropertyAssignment(node) && !hasOnlySimplePropertyName(node.name)) { valid = false; return; }
    if (ts.isShorthandPropertyAssignment(node) && DANGEROUS_PROPERTIES.has(node.name.text)) { valid = false; return; }

    if (ts.isIdentifier(node) && !isIdentifierBinding(node) && !isPropertyKey(node)) {
      if (!locals.has(node.text) && node.text !== "graph" && node.text !== "model" &&
          node.text !== "Error" && node.text !== "undefined") {
        valid = false;
        return;
      }
    }

    if (ts.isNewExpression(node)) {
      if (pathOf(node.expression) !== "Error" || (node.arguments?.length ?? 0) > 1) {
        valid = false;
        return;
      }
    }

    if (ts.isPrefixUnaryExpression(node)) {
      if (![ts.SyntaxKind.ExclamationToken, ts.SyntaxKind.PlusToken, ts.SyntaxKind.MinusToken].includes(node.operator)) {
        valid = false;
        return;
      }
    }
    if (ts.isPostfixUnaryExpression(node)) {
      if (node.operator !== ts.SyntaxKind.PlusPlusToken ||
          !ts.isIdentifier(node.operand) ||
          !loops.some(loop => loop.incrementor === node) ||
          !loopIndices.has(node.operand.text)) {
        valid = false;
        return;
      }
    }
    if (ts.isBinaryExpression(node)) {
      const kind = node.operatorToken.kind;
      const assignment = kind >= ts.SyntaxKind.FirstAssignment && kind <= ts.SyntaxKind.LastAssignment;
      if (assignment) {
        if (kind !== ts.SyntaxKind.EqualsToken || !ts.isIdentifier(node.left) ||
            !locals.has(node.left.text) || NATIVE_BINDINGS.has(node.left.text) ||
            arrayNames.has(node.left.text) || parentVariables.has(node.left.text) ||
            loopIndices.has(node.left.text)) {
          valid = false;
          return;
        }
      } else if (!SAFE_BINARY_OPERATORS.has(kind)) {
        valid = false;
        return;
      }
    }

    if (ts.isCallExpression(node)) {
      const path = pathOf(node.expression);
      if (path && SAFE_CALLS.has(path)) {
        if (!callArityAllowed(path, node.arguments.length)) { valid = false; return; }
        if (path === "graph.insertVertex" || path === "graph.insertEdge") {
          if (loopAncestors(node) || helperAncestor(node)) { valid = false; return; }
          insertCounts[path === "graph.insertVertex" ? "vertices" : "edges"]++;
          insertionCalls.push({node, path});
          const statement = directExpressionStatement(node);
          if (!statement) { valid = false; return; }
          if (ts.isBinaryExpression(node.parent) && node.parent.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
              ts.isIdentifier(node.parent.left)) {
            insertedResultNames.add(node.parent.left.text);
          }
          const firstArgument = node.arguments[0];
          const parentIsDefault = firstArgument && (
            (ts.isIdentifier(firstArgument) && parentVariables.has(firstArgument.text)) ||
            (ts.isCallExpression(firstArgument) && pathOf(firstArgument.expression) === "graph.getDefaultParent" &&
              firstArgument.arguments.length === 0)
          );
          if (!parentIsDefault) { valid = false; return; }
          if (path === "graph.insertEdge") {
            if (!node.arguments[3] || !node.arguments[4] ||
                node.arguments[3].kind === ts.SyntaxKind.NullKeyword ||
                node.arguments[4].kind === ts.SyntaxKind.NullKeyword) {
              valid = false;
              return;
            }
          }
        }
        if (path === "model.beginUpdate") beginCalls.push(node);
        if (path === "model.endUpdate") endCalls.push(node);
        if (path === "graph.refresh") refreshCalls.push(node);
      } else if (path && path.endsWith(".push")) {
        const receiver = path.slice(0, -".push".length);
        if (!arrayNames.has(receiver) || node.arguments.length > 1) { valid = false; return; }
      } else if (ts.isIdentifier(node.expression) && helpers.has(node.expression.text)) {
        if (helperAncestor(node) || node.arguments.length > 2) { valid = false; return; }
      } else {
        valid = false;
        return;
      }
    }

    if (ts.isThrowStatement(node)) {
      if (!node.expression || !ts.isNewExpression(node.expression) ||
          pathOf(node.expression.expression) !== "Error") {
        valid = false;
        return;
      }
    }
  });
  if (!valid || insertionCalls.length === 0 ||
      insertCounts.vertices > MAX_INSERTED_VERTICES ||
      insertCounts.edges > MAX_INSERTED_EDGES ||
      insertCounts.vertices + insertCounts.edges > MAX_TOTAL_INSERTIONS) return false;

  if (beginCalls.length !== 1 || endCalls.length !== 1 || helperNodes.length > 12) return false;
  const beginStatement = directExpressionStatement(beginCalls[0]);
  const endStatement = directExpressionStatement(endCalls[0]);
  if (!beginStatement || !endStatement || beginStatement.parent !== body) return false;
  const beginIndex = body.statements.indexOf(beginStatement);
  const protectedTry = body.statements[beginIndex + 1];
  if (!protectedTry || !ts.isTryStatement(protectedTry) || protectedTry.parent !== body ||
      protectedTry.finallyBlock === undefined || protectedTry.catchClause ||
      protectedTry.finallyBlock.statements.length !== 1 ||
      protectedTry.finallyBlock.statements[0] !== endStatement ||
      endStatement.parent !== protectedTry.finallyBlock) return false;

  for (const insertion of insertionCalls) {
    const statement = directExpressionStatement(insertion.node);
    if (!statement || statement.parent !== protectedTry.tryBlock) return false;
  }
  const topLevelRefresh = refreshCalls.some(call => {
    const statement = directExpressionStatement(call);
    return Boolean(statement && statement.parent === body && call.pos > protectedTry.end);
  });
  if (!topLevelRefresh) return false;

  const resultReturn = body.statements.find(statement =>
    ts.isReturnStatement(statement) && statement.pos > protectedTry.end && Boolean(statement.expression)
  );
  if (!resultReturn || !ts.isReturnStatement(resultReturn) || !resultReturn.expression) return false;

  let verifiesInsertedCell = false;
  visitTree(resultReturn.expression, node => {
    if (verifiesInsertedCell || !ts.isCallExpression(node)) return;
    const path = pathOf(node.expression);
    if (!path || !READ_ONLY_CALLS.has(path)) return;
    if (node.arguments.some(argument =>
      [...insertedResultNames].some(name => containsIdentifier(argument, name))
    )) verifiesInsertedCell = true;
  });
  return verifiesInsertedCell;
}
