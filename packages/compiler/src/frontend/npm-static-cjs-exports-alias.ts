/* CommonJS modules whose export object is one of their own functions:
 *
 *   exports = module.exports = SemVer;   // or module.exports = SemVer;
 *   exports.parse = parse;               // or module.exports.parse = …
 *   function SemVer(version) { … }
 *
 * After that statement `module.exports` (and, after the rebinding form,
 * `exports`) IS the function, so every member read or write through them
 * is a member of the function itself. The pass respells those accesses
 * through the function's name, the expando form both resolvers model
 * (members on a function declaration), and drops the `exports =`
 * rebinding the static export protocol has no storage for.
 *
 * The function may also be a `var` or `const` bound to a function
 * expression or arrow above the statement (esbuild hoists a bundled
 * module's top-level `const` to such a `var`): members on it are the same
 * expando form.
 *
 * Exact only while nothing can observe the module before the statement
 * runs and nothing replaces the export object again: the statement is a
 * top-level statement preceded only by inert declarations, it is the
 * file's only write of `module.exports` and `exports`, the function is a
 * top-level declaration nothing reassigns and the file's only binding of
 * its name, and `exports`/`module` are the CommonJS globals (never
 * declared in the file). Other shapes answer
 * null and keep their existing treatment. */
import * as ts from "./ts7/syntax.js";
import {
  applyEdits,
  countDeclarations,
  declaredNames,
  isWritten,
  references,
  unparen,
  type Edit,
} from "./npm-static-bundled-chunks.js";
import { tokenStartOfNode } from "./ts7/node-functions.js";

function isModuleExports(e: ts.Expression): e is ts.PropertyAccessExpression {
  const x = unparen(e);
  return (
    ts.isPropertyAccessExpression(x) &&
    !x.questionDotToken &&
    ts.isIdentifier(x.expression) &&
    x.expression.text === "module" &&
    x.name.text === "exports"
  );
}

/** `require("x")`, or esbuild's interop wrapper around one
 * (`__toESM(require("x"))`, `__toESM(require("x"), 1)`). */
function isRequireValue(expr: ts.Expression): boolean {
  const e = unparen(expr);
  if (!ts.isCallExpression(e) || !ts.isIdentifier(e.expression)) return false;
  const args = e.arguments.nodes;
  if (e.expression.text === "require")
    return (
      args.length === 1 &&
      (ts.isStringLiteral(args[0]!) || ts.isNoSubstitutionTemplateLiteral(args[0]!))
    );
  if (e.expression.text === "__toESM")
    return (args.length === 1 || args.length === 2) && isRequireValue(args[0]!);
  return false;
}

/** `{ a, b: c }`: a destructuring of plain member reads (no defaults, no
 * computed keys, no nested patterns, no rest), which runs no user code. */
function plainObjectPattern(name: ts.BindingName): boolean {
  return (
    ts.isObjectBindingPattern(name) &&
    name.elements.nodes.every(
      (el) =>
        el.dotDotDotToken === undefined &&
        el.initializer === undefined &&
        ts.isIdentifier(el.name) &&
        (el.propertyName === undefined || ts.isIdentifier(el.propertyName)),
    )
  );
}

/** True for a statement whose evaluation runs no code that could observe
 * the export object: declarations and member writes (`F.prototype.m =
 * function …`) without calls, and directives. */
function inert(stmt: ts.Statement): boolean {
  return inertOrRequire(stmt, false);
}

/** `inert`, and with `requires` also bindings of required modules (`var x
 * = require("x")`: another module can reach this one's export object only
 * through a require cycle, which preflight's cycle rules already judge). */
function inertOrRequire(stmt: ts.Statement, requires: boolean): boolean {
  if (ts.isFunctionDeclaration(stmt) || ts.isEmptyStatement(stmt)) return true;
  if (
    requires &&
    ts.isVariableStatement(stmt) &&
    stmt.declarationList.declarations.nodes.every(
      (d) =>
        (ts.isIdentifier(d.name) || plainObjectPattern(d.name)) &&
        d.initializer !== undefined &&
        isRequireValue(d.initializer),
    )
  )
    return true;
  if (ts.isExpressionStatement(stmt) && ts.isStringLiteral(stmt.expression)) return true;
  if (ts.isExpressionStatement(stmt)) {
    const e = unparen(stmt.expression);
    if (
      !ts.isBinaryExpression(e) ||
      e.operatorToken.kind !== ts.SyntaxKind.EqualsToken ||
      !(ts.isPropertyAccessExpression(e.left) || ts.isElementAccessExpression(e.left))
    )
      return false;
    let root: ts.Expression = e.left;
    while (ts.isPropertyAccessExpression(root) || ts.isElementAccessExpression(root))
      root = root.expression;
    if (!ts.isIdentifier(root) || root.text === "module" || root.text === "exports") return false;
  } else if (!ts.isVariableStatement(stmt)) return false;
  let calls = false;
  ts.walkPreorder(stmt, (n) => {
    if (calls) return "stop";
    if (ts.isArrowFunction(n) || ts.isFunctionExpression(n)) return "skip";
    if (ts.isCallExpression(n) || ts.isNewExpression(n) || ts.isTaggedTemplateExpression(n))
      calls = true;
    return undefined;
  });
  return !calls;
}

export function normalizeCjsFunctionExports(sf: ts.SourceFile): string | null {
  const source = sf.text;
  if (!source.includes("module.exports")) return null;
  if (!sf.fileName.endsWith(".cjs") && ts.isExternalModule(sf)) return null;
  const declared = declaredNames(sf);
  if (declared.has("exports") || declared.has("module")) return null;

  // The whole-export statement: `[exports =] module.exports = W;`.
  let whole: { stmt: ts.ExpressionStatement; fn: string; rebinds: boolean } | null = null;
  const stmts = sf.statements.nodes;
  for (let i = 0; i < stmts.length; i++) {
    const stmt = stmts[i]!;
    if (!ts.isExpressionStatement(stmt)) continue;
    const top = unparen(stmt.expression);
    if (!ts.isBinaryExpression(top) || top.operatorToken.kind !== ts.SyntaxKind.EqualsToken)
      continue;
    let e: ts.BinaryExpression = top;
    let rebinds = false;
    if (ts.isIdentifier(top.left) && top.left.text === "exports") {
      const inner = unparen(top.right);
      if (!ts.isBinaryExpression(inner) || inner.operatorToken.kind !== ts.SyntaxKind.EqualsToken)
        continue;
      rebinds = true;
      e = inner;
    }
    if (!isModuleExports(e.left)) continue;
    const value = unparen(e.right);
    if (!ts.isIdentifier(value)) return null;
    if (whole !== null || !stmts.slice(0, i).every((st) => inertOrRequire(st, true))) return null;
    whole = { stmt, fn: value.text, rebinds };
  }
  if (whole === null) return null;
  const fnName = whole.fn;
  const wholeAt = stmts.indexOf(whole.stmt);
  // A function declaration's member exports already compile as member
  // exports, which keep their declared types; respelling them as members of
  // the function needs dynamic values, so with requires above the export
  // only a function bound to a variable (esbuild's hoisted `var`, whose
  // member exports have no other form) is respelled.
  const varBound = stmts.some((st, i) => i < wholeAt && functionValuedVar(st, fnName));
  if (!varBound && !stmts.slice(0, wholeAt).every(inert)) return null;
  const fnDecls = stmts.filter(
    (st, i) =>
      (ts.isFunctionDeclaration(st) && st.name?.text === fnName && st.body !== undefined) ||
      (i < wholeAt && functionValuedVar(st, fnName)),
  );
  // The respelled reads name the function from wherever they sit, so no
  // other binding of its name (a parameter, a local, a nested function)
  // may exist anywhere in the file.
  if (fnDecls.length !== 1 || countDeclarations(sf, fnName) !== 1) return null;

  const edits: Edit[] = [];
  let unsafe = false;
  const refs = references(sf);
  for (const r of refs) {
    if (r.text === fnName && isWritten(r)) unsafe = true;
    if (r.text === "exports") {
      if (isWritten(r)) {
        // Only the whole statement's own rebinding.
        const assign = r.parent;
        if (
          !whole.rebinds ||
          assign === undefined ||
          !ts.isBinaryExpression(assign) ||
          assign.parent !== whole.stmt ||
          assign.left !== r
        )
          unsafe = true;
        continue;
      }
      // Without the rebinding, `exports` keeps the replaced object.
      if (!whole.rebinds || tokenStartOfNode(r) < whole.stmt.end) {
        unsafe = true;
        continue;
      }
      // `{ exports }` keeps its key: the shorthand spells out the value.
      const shorthand =
        r.parent !== undefined && ts.isShorthandPropertyAssignment(r.parent) && r.parent.name === r;
      edits.push({
        start: tokenStartOfNode(r),
        end: r.end,
        text: shorthand ? `exports: ${fnName}` : fnName,
      });
      continue;
    }
    if (r.text === "module") {
      const access = r.parent;
      if (access === undefined || !isModuleExports(access as ts.Expression)) continue;
      const outer = access.parent;
      if (outer !== undefined && ts.isBinaryExpression(outer) && outer.left === access) {
        if (
          outer.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
          outer.operatorToken.kind <= ts.SyntaxKind.LastAssignment &&
          !(
            (outer.parent === whole.stmt && !whole.rebinds) ||
            (whole.rebinds && outer.parent?.parent === whole.stmt)
          )
        )
          unsafe = true;
        continue;
      }
      // A member access through module.exports: a member of the function.
      if (
        outer !== undefined &&
        (ts.isPropertyAccessExpression(outer) || ts.isElementAccessExpression(outer)) &&
        outer.expression === access
      ) {
        if (tokenStartOfNode(access) < whole.stmt.end && !insideFunction(access)) unsafe = true;
        edits.push({ start: tokenStartOfNode(access), end: access.end, text: fnName });
      }
    }
  }
  if (unsafe) return null;
  if (whole.rebinds) {
    // `exports = module.exports = W` → `module.exports = W`.
    const e = unparen(whole.stmt.expression) as ts.BinaryExpression;
    edits.push({ start: tokenStartOfNode(e), end: tokenStartOfNode(unparen(e.right)), text: "" });
  }
  if (edits.length === 0) return null;
  return applyEdits(source, 0, source.length, edits);
}

/** `var name = function …` / `const name = (…) => …`: one declarator
 * whose initializer is a function expression or arrow. */
function functionValuedVar(stmt: ts.Statement, name: string): boolean {
  if (!ts.isVariableStatement(stmt)) return false;
  if ((stmt.declarationList.flags & ts.NodeFlags.Let) !== 0) return false;
  const decls = stmt.declarationList.declarations.nodes;
  if (decls.length !== 1) return false;
  const d = decls[0]!;
  if (!ts.isIdentifier(d.name) || d.name.text !== name || d.initializer === undefined) return false;
  const init = unparen(d.initializer);
  return ts.isFunctionExpression(init) || ts.isArrowFunction(init);
}

function insideFunction(node: ts.Node): boolean {
  for (let p = node.parent; p !== undefined && !ts.isSourceFile(p); p = p.parent) {
    if (ts.isFunctionLike(p)) return true;
  }
  return false;
}
