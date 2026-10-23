import * as ts from "typescript";

const MAX_SCRIPT_LENGTH = 12_000;
const MAX_VERTICES = 6;
const MAX_EDGES = 8;
const MAX_INSERTIONS = 12;

const SAFE_CALL_ARITY: Record<string, number | readonly number[]> = {
  "graph.getDefaultParent": 0,
  "graph.insertVertex": [7, 8],
  "graph.insertEdge": [5, 6],
  "graph.refresh": 0,
  "graph.view.validate": 0,
  "graph.view.getState": 1,
  "graph.convertValueToString": 1,
  "model.beginUpdate": 0,
  "model.endUpdate": 0,
  "model.getCell": 1,
  "model.getGeometry": 1,
  "model.getStyle": 1,
  "model.getTerminal": 2
};
const SAFE_PROPERTIES = new Set(["id", "x", "y", "width", "height", "length", "absolutePoints", "points", "view"]);
const DANGEROUS_PROPERTIES = new Set(["constructor", "__proto__", "prototype", "caller", "callee", "arguments", "__defineGetter__", "__defineSetter__"]);
const ALLOWED_BINARY = new Set([
  ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.EqualsEqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken,
  ts.SyntaxKind.LessThanToken, ts.SyntaxKind.LessThanEqualsToken,
  ts.SyntaxKind.GreaterThanToken, ts.SyntaxKind.GreaterThanEqualsToken,
  ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.BarBarToken,
  ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.PlusToken, ts.SyntaxKind.MinusToken,
  ts.SyntaxKind.AsteriskToken, ts.SyntaxKind.SlashToken, ts.SyntaxKind.PercentToken
]);

function pathOf(node: ts.Expression): string | null {
  if (ts.isIdentifier(node)) return node.text;
  if (ts.isPropertyAccessExpression(node) && !node.questionDotToken) {
    const root = pathOf(node.expression);
    return root ? root + "." + node.name.text : null;
  }
  return null;
}
function visit(node: ts.Node, callback: (node: ts.Node) => void): void {
  callback(node);
  ts.forEachChild(node, child => visit(child, callback));
}
function isBindingIdentifier(node: ts.Identifier): boolean {
  const parent = node.parent;
  return (ts.isVariableDeclaration(parent) && parent.name === node) ||
    (ts.isParameter(parent) && parent.name === node) ||
    (ts.isFunctionDeclaration(parent) && parent.name === node);
}
function isPropertyNameIdentifier(node: ts.Identifier): boolean {
  const parent = node.parent;
  return (ts.isPropertyAccessExpression(parent) && parent.name === node) ||
    (ts.isPropertyAssignment(parent) && parent.name === node && !ts.isComputedPropertyName(parent.name)) ||
    (ts.isShorthandPropertyAssignment(parent) && parent.name === node);
}
function directStatementForCall(call: ts.CallExpression): ts.ExpressionStatement | null {
  let expression: ts.Node = call;
  if (ts.isBinaryExpression(call.parent) && call.parent.right === call &&
      call.parent.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isIdentifier(call.parent.left)) expression = call.parent;
  return ts.isExpressionStatement(expression.parent) && expression.parent.expression === expression
    ? expression.parent : null;
}
function containsIdentifier(node: ts.Node, name: string): boolean {
  let found = false;
  visit(node, child => {
    if (ts.isIdentifier(child) && child.text === name && !isPropertyNameIdentifier(child)) found = true;
  });
  return found;
}
function conditionNegatesIdentifier(node: ts.Node, name: string): boolean {
  let found = false;
  visit(node, child => {
    if (ts.isPrefixUnaryExpression(child) && child.operator === ts.SyntaxKind.ExclamationToken &&
        ts.isIdentifier(child.operand) && child.operand.text === name) found = true;
  });
  return found;
}
function throwsError(node: ts.Node): boolean {
  let found = false;
  visit(node, child => {
    if (ts.isThrowStatement(child) && child.expression && ts.isNewExpression(child.expression) &&
        ts.isIdentifier(child.expression.expression) && child.expression.expression.text === "Error") found = true;
  });
  return found;
}
function hasOwnCall(path: string): boolean {
  return Object.prototype.hasOwnProperty.call(SAFE_CALL_ARITY, path);
}
function approvedProperty(node: ts.PropertyAccessExpression): boolean {
  const path = pathOf(node);
  if (path && hasOwnCall(path)) return true;
  if (path === "graph.view") return true;
  const last = node.name.text;
  const callResult = ts.isCallExpression(node.expression) && pathOf(node.expression.expression) !== null &&
    hasOwnCall(pathOf(node.expression.expression) as string);
  return SAFE_PROPERTIES.has(last) && !DANGEROUS_PROPERTIES.has(last) && (Boolean(path) || callResult);
}

/** Fails closed unless a small script only inserts cells and returns a read-only postcondition. */
export function isAutoConfirmableCreationScript(script: string): boolean {
  if (!script.trim() || script.length > MAX_SCRIPT_LENGTH) return false;
  const source = ts.createSourceFile(
    "native-drawio-script.js",
    "function __nativeScript() {\n" + script + "\n}",
    ts.ScriptTarget.Latest, true, ts.ScriptKind.JS
  );
  const sourceFile = source as ts.SourceFile & { parseDiagnostics?: readonly ts.Diagnostic[] };
  const wrapper = source.statements[0];
  if ((sourceFile.parseDiagnostics && sourceFile.parseDiagnostics.length > 0) ||
      source.statements.length !== 1 || !wrapper || !ts.isFunctionDeclaration(wrapper) || !wrapper.body) return false;

  const body = wrapper.body;
  const locals = new Set<string>();
  const defaultParents = new Set<string>();
  const lookupVariables = new Set<string>();
  const guardedLookups = new Set<string>();
  const createdVariables = new Set<string>();
  const vertices: ts.CallExpression[] = [];
  const edges: ts.CallExpression[] = [];
  const beginCalls: ts.CallExpression[] = [];
  const endCalls: ts.CallExpression[] = [];
  const refreshCalls: ts.CallExpression[] = [];
  const tryStatements: ts.TryStatement[] = [];
  let valid = true;

  visit(body, node => {
    if (ts.isVariableDeclaration(node)) {
      if (!ts.isIdentifier(node.name)) { valid = false; return; }
      const name = node.name.text;
      if (["graph", "model", "ui", "editor", "window", "globalThis", "document", "fetch", "Function", "eval"].includes(name) ||
          DANGEROUS_PROPERTIES.has(name)) { valid = false; return; }
      locals.add(name);
      if (node.initializer && ts.isCallExpression(node.initializer)) {
        const callPath = pathOf(node.initializer.expression);
        if (callPath === "graph.getDefaultParent" && node.initializer.arguments.length === 0) defaultParents.add(name);
        if (callPath === "model.getCell" && node.initializer.arguments.length === 1 &&
            ts.isStringLiteralLike(node.initializer.arguments[0])) lookupVariables.add(name);
      }
    }
    if (ts.isFunctionDeclaration(node) && node !== wrapper) valid = false;
    if (ts.isTryStatement(node)) tryStatements.push(node);
    if (ts.isIfStatement(node) && throwsError(node.thenStatement)) {
      for (const name of lookupVariables) {
        if (conditionNegatesIdentifier(node.expression, name)) guardedLookups.add(name);
      }
    }
  });
  if (!valid || lookupVariables.size === 0 || [...lookupVariables].some(name => !guardedLookups.has(name))) return false;

  const allowedStatements = new Set([
    ts.SyntaxKind.Block, ts.SyntaxKind.VariableStatement, ts.SyntaxKind.ExpressionStatement,
    ts.SyntaxKind.IfStatement, ts.SyntaxKind.TryStatement, ts.SyntaxKind.ReturnStatement,
    ts.SyntaxKind.ThrowStatement, ts.SyntaxKind.EmptyStatement
  ]);
  visit(body, node => {
    if (!valid) return;
    if (ts.isStatement(node) && !allowedStatements.has(node.kind)) { valid = false; return; }
    if (ts.isAwaitExpression(node) || ts.isYieldExpression(node) || ts.isWithStatement(node) ||
        ts.isDeleteExpression(node) || ts.isTaggedTemplateExpression(node) || ts.isTemplateExpression(node) ||
        ts.isArrowFunction(node) || ts.isFunctionExpression(node) || ts.isClassDeclaration(node) ||
        ts.isClassExpression(node) || ts.isMethodDeclaration(node) || ts.isGetAccessorDeclaration(node) ||
        ts.isSetAccessorDeclaration(node) || ts.isForInStatement(node) || ts.isForOfStatement(node) ||
        ts.isWhileStatement(node) || ts.isDoStatement(node) || ts.isSpreadElement(node) ||
        ts.isSpreadAssignment(node) || ts.isElementAccessExpression(node) || ts.isImportTypeNode(node)) {
      valid = false; return;
    }
    if (ts.isTryStatement(node) && (node.catchClause || !node.finallyBlock)) { valid = false; return; }
    if (ts.isPropertyAccessExpression(node) &&
        (node.questionDotToken || node.name.text === "constructor" || !approvedProperty(node) ||
         (pathOf(node) || "").split(".").some(part => DANGEROUS_PROPERTIES.has(part)))) {
      valid = false; return;
    }
    if (ts.isPropertyAssignment(node) &&
        (ts.isComputedPropertyName(node.name) || (!ts.isIdentifier(node.name) && !ts.isStringLiteralLike(node.name)))) {
      valid = false; return;
    }
    if (ts.isIdentifier(node) && !isBindingIdentifier(node) && !isPropertyNameIdentifier(node)) {
      if (!locals.has(node.text) && !["graph", "model", "Error", "undefined"].includes(node.text)) {
        valid = false; return;
      }
    }
    if (ts.isNewExpression(node) &&
        (!ts.isIdentifier(node.expression) || node.expression.text !== "Error" || (node.arguments || []).length > 1)) {
      valid = false; return;
    }
    if (ts.isPrefixUnaryExpression(node) &&
        ![ts.SyntaxKind.ExclamationToken, ts.SyntaxKind.PlusToken, ts.SyntaxKind.MinusToken].includes(node.operator)) {
      valid = false; return;
    }
    if (ts.isPostfixUnaryExpression(node)) { valid = false; return; }
    if (ts.isBinaryExpression(node)) {
      const kind = node.operatorToken.kind;
      const assignment = kind >= ts.SyntaxKind.FirstAssignment && kind <= ts.SyntaxKind.LastAssignment;
      if (assignment) {
        if (kind !== ts.SyntaxKind.EqualsToken || !ts.isIdentifier(node.left) || !locals.has(node.left.text) ||
            defaultParents.has(node.left.text) || lookupVariables.has(node.left.text)) valid = false;
      } else if (!ALLOWED_BINARY.has(kind)) valid = false;
    }
    if (ts.isCallExpression(node)) {
      const path = pathOf(node.expression);
      if (!path || !hasOwnCall(path)) { valid = false; return; }
      const arity = SAFE_CALL_ARITY[path];
      const arityAllowed = typeof arity === "number" ? arity === node.arguments.length : arity.includes(node.arguments.length);
      if (!arityAllowed) { valid = false; return; }
      if (path === "graph.insertVertex" || path === "graph.insertEdge") {
        const statement = directStatementForCall(node);
        if (!statement) { valid = false; return; }
        if (path === "graph.insertVertex") vertices.push(node);
        else edges.push(node);
        const parentArg = node.arguments[0];
        if (!parentArg ||
            !(ts.isIdentifier(parentArg) && defaultParents.has(parentArg.text)) &&
            !(ts.isCallExpression(parentArg) && pathOf(parentArg.expression) === "graph.getDefaultParent")) {
          valid = false; return;
        }
        if (path === "graph.insertEdge") {
          const src = node.arguments[3];
          const dst = node.arguments[4];
          if (!src || !dst || !ts.isIdentifier(src) || !ts.isIdentifier(dst) ||
              !locals.has(src.text) || !locals.has(dst.text)) { valid = false; return; }
        }
        const parent = statement.parent;
        const protectedTry = parent && ts.isBlock(parent) && ts.isTryStatement(parent.parent) &&
          parent.parent.tryBlock === parent ? parent.parent : null;
        if (!protectedTry || !protectedTry.finallyBlock || protectedTry.finallyBlock.statements.length !== 1) {
          valid = false; return;
        }
        if (ts.isBinaryExpression(node.parent) && node.parent.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
            ts.isIdentifier(node.parent.left)) createdVariables.add(node.parent.left.text);
      }
      if (path === "model.beginUpdate") beginCalls.push(node);
      if (path === "model.endUpdate") endCalls.push(node);
      if (path === "graph.refresh") refreshCalls.push(node);
    }
    if (ts.isThrowStatement(node) &&
        (!node.expression || !ts.isNewExpression(node.expression) ||
         !ts.isIdentifier(node.expression.expression) || node.expression.expression.text !== "Error")) valid = false;
  });

  if (!valid || vertices.length === 0 || vertices.length > MAX_VERTICES ||
      edges.length > MAX_EDGES || vertices.length + edges.length > MAX_INSERTIONS ||
      beginCalls.length !== 1 || endCalls.length !== 1 || refreshCalls.length !== 1 ||
      tryStatements.length !== 1) return false;

  const begin = directStatementForCall(beginCalls[0]);
  const end = directStatementForCall(endCalls[0]);
  const refresh = directStatementForCall(refreshCalls[0]);
  const protectedTry = tryStatements[0];
  if (!begin || begin.parent !== body || !end || end.parent !== protectedTry.finallyBlock ||
      !refresh || refresh.parent !== body || refresh.pos < protectedTry.end ||
      body.statements.indexOf(begin) + 1 !== body.statements.indexOf(protectedTry) ||
      protectedTry.finallyBlock?.statements.length !== 1 ||
      protectedTry.finallyBlock.statements[0] !== end) return false;
  for (const call of [...vertices, ...edges]) {
    const statement = directStatementForCall(call);
    if (!statement || statement.parent !== protectedTry.tryBlock) return false;
  }

  const returns = body.statements.filter(ts.isReturnStatement);
  if (returns.length !== 1 || !returns[0].expression || returns[0].pos < refresh.end) return false;
  let inspectsCreation = false;
  visit(returns[0].expression, node => {
    if (!ts.isCallExpression(node)) return;
    const path = pathOf(node.expression);
    if (path && ["model.getTerminal", "model.getCell", "model.getGeometry", "model.getStyle",
      "graph.convertValueToString", "graph.view.getState"].includes(path) &&
      node.arguments.some(arg => [...createdVariables].some(name => containsIdentifier(arg, name)))) inspectsCreation = true;
  });
  return inspectsCreation;
}
