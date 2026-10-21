import * as ts from "../ts7/adapter.js";
import { everyStmtList } from "../../ir/traverse.js";
import type { IrExpr, IrFunction, IrStmt, IrType } from "../../ir/ir.js";
import { locOf } from "../program.js";
import { npmStaticPackageOfPath } from "../npm-static.js";
import type { Lowerer } from "./lowerer.js";
import {
  exactClassOfReceiver,
  findMethodOn,
  findGenericMethodOn,
  type ClassInfo,
} from "./lower-classes.js";
import { classPrototypeData } from "./class-prototypes.js";
import { bindingNeverReassigned } from "./binding-analysis.js";

/** A registry of existing class/function values allocates data, but does
 * not execute those bodies. Keep its initializer at its source position
 * and lower it only when a reached body observes the binding. Otherwise
 * merely collecting an unused registry would reach every constructor. */
export class DeferredModuleInitializers {
  private readonly pending = new Map<string, { loc: IrStmt["loc"]; lower: () => IrStmt[] }[]>();
  private readonly registryGlobals = new Set<string>();

  defer(lowerer: Lowerer, statement: ts.Statement): IrStmt | null {
    let key: string;
    if (
      ts.isVariableStatement(statement) &&
      statement.declarationList.declarations.nodes.length === 1
    ) {
      const declaration = statement.declarationList.declarations.nodes[0]!;
      if (!ts.isIdentifier(declaration.name) || !declaration.initializer) return null;
      const symbol = lowerer.checker.getSymbolAtLocation(declaration.name);
      const global = symbol && lowerer.globalsBySymbol.get(symbol);
      if (!global || !registryInitializer(lowerer, declaration.initializer, statement)) {
        return null;
      }
      key = global.id;
      if (
        ts.isObjectLiteralExpression(declaration.initializer) &&
        declaration.initializer.properties.nodes.every(
          (property) =>
            (ts.isPropertyAssignment(property) &&
              !ts.isComputedPropertyName(property.name) &&
              propertyName(property.name) !== "__proto__") ||
            ts.isShorthandPropertyAssignment(property),
        )
      )
        this.registryGlobals.add(key);
    } else if (
      ts.isExpressionStatement(statement) &&
      ts.isBinaryExpression(statement.expression) &&
      statement.expression.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isPropertyAccessExpression(statement.expression.left)
    ) {
      const { left, right } = statement.expression;
      if (!registryInitializer(lowerer, right, statement)) {
        return null;
      }
      let owner = left.expression;
      const prototype = ts.isPropertyAccessExpression(owner) && owner.name.text === "prototype";
      if (prototype) owner = (owner as ts.PropertyAccessExpression).expression;
      const info = exactClassOfReceiver(lowerer, owner);
      if (
        info &&
        info.decl !== null &&
        ts.getSourceFileOfNode(info.decl) === ts.getSourceFileOfNode(statement) &&
        ts.tokenStartOfNode(info.decl) < ts.tokenStartOfNode(statement) &&
        !info.localClass &&
        !info.classDecorators &&
        !info.generic &&
        !info.callableBase &&
        !info.mixinInstance &&
        !info.def.runtime
      ) {
        if (!classWriteIsUnobserved(lowerer, info, statement)) return null;
        for (let current: ClassInfo | null = info; current; current = current.base) {
          if (
            current.methods.has(`set:${left.name.text}`) ||
            current.staticMethods?.has(`set:${left.name.text}`)
          )
            return null;
        }
        key = `${prototype ? "prototype" : "class"}:${info.def.name}`;
        if (prototype) classPrototypeData(lowerer, info, locOf(left), undefined, true);
      } else {
        if (!ts.isIdentifier(owner)) return null;
        const symbol = lowerer.resolveValueSymbol(owner);
        const global = symbol && lowerer.globalsBySymbol.get(symbol);
        if (
          !global ||
          !this.registryGlobals.has(global.id) ||
          !symbol ||
          !registryOwnerIsData(lowerer, symbol, statement)
        )
          return null;
        key = global.id;
      }
    } else return null;
    const block: Extract<IrStmt, { kind: "block" }> = {
      kind: "block",
      body: [],
      loc: locOf(statement),
    };
    const context = lowerer.ctx;
    const moduleIndex = [...lowerer.initNameOf.keys()].indexOf(ts.getSourceFileOfNode(statement));
    const initializers = this.pending.get(key) ?? [];
    initializers.push({
      loc: block.loc,
      lower: () => {
        const previousClass = lowerer.currentClass;
        lowerer.currentClass = null;
        lowerer.fnStack.push(context);
        try {
          return lowerer.shapes.withDeclaredOrderPriority([2, moduleIndex], () =>
            lowerer.lowerStmts([statement]),
          );
        } finally {
          lowerer.fnStack.pop();
          lowerer.currentClass = previousClass;
        }
      },
    });
    this.pending.set(key, initializers);
    return block;
  }

  process(lowerer: Lowerer, functions: readonly IrFunction[]): boolean {
    if (this.pending.size === 0) return false;
    const demanded = new Set<string>();
    const classHelpers = new Map<string, string>();
    for (const info of lowerer.classes.values()) {
      if (info.staticDataHelper) classHelpers.set(info.staticDataHelper, `class:${info.def.name}`);
      if (info.def.prototypeDataHelper)
        classHelpers.set(info.def.prototypeDataHelper, `prototype:${info.def.name}`);
    }
    const seen = new Set<IrType>();
    const byName = new Map(functions.map((fn) => [fn.name, fn]));
    const inspectedHelpers = new Set<string>();
    const usedHelpers: string[] = [];
    const demandType = (type: IrType): void => {
      if (seen.has(type)) return;
      seen.add(type);
      if (type.kind === "object" || type.kind === "classval") {
        for (let info = lowerer.classes.get(type.className); info; info = info.base ?? undefined) {
          const key = `class:${info.def.name}`;
          if (this.pending.has(key)) demanded.add(key);
          const prototype = `prototype:${info.def.name}`;
          if (type.kind === "object" && this.pending.has(prototype)) demanded.add(prototype);
        }
      } else if (type.kind === "array") demandType(type.elem);
      else if (type.kind === "union") lowerer.unions.get(type.unionId)?.arms.forEach(demandType);
      else if (type.kind === "record") {
        const shape = lowerer.shapes.get(type.shapeId);
        shape?.fields.forEach((field) => demandType(field.type));
        if (shape?.indexValue) demandType(shape.indexValue);
      } else if (type.kind === "func") {
        type.params.forEach(demandType);
        demandType(type.ret);
      } else if (type.kind === "promise") demandType(type.inner);
    };
    for (const fn of functions) {
      // Prototype helpers are allocated eagerly while collecting metadata.
      // Their base-helper calls must not make unused classes reachable.
      if (classHelpers.has(fn.name)) continue;
      fn.params.forEach((param) => demandType(param.type));
      demandType(fn.returnType);
      everyStmtList(fn.body, {
        stmt: () => true,
        expr: (expr) => {
          demandType(expr.type);
          if (readsBinding(expr) && this.pending.has(expr.localId)) demanded.add(expr.localId);
          if (expr.kind === "call") {
            const owner = classHelpers.get(expr.callee);
            if (owner) {
              if (this.pending.has(owner)) demanded.add(owner);
              usedHelpers.push(expr.callee);
            }
          }
          return true;
        },
      });
    }
    while (usedHelpers.length) {
      const name = usedHelpers.pop()!;
      if (inspectedHelpers.has(name)) continue;
      inspectedHelpers.add(name);
      const fn = byName.get(name);
      if (!fn) continue;
      everyStmtList(fn.body, {
        stmt: () => true,
        expr: (expr) => {
          demandType(expr.type);
          if (readsBinding(expr) && this.pending.has(expr.localId)) demanded.add(expr.localId);
          if (expr.kind === "call") {
            const owner = classHelpers.get(expr.callee);
            if (owner) {
              if (this.pending.has(owner)) demanded.add(owner);
              usedHelpers.push(expr.callee);
            }
          }
          return true;
        },
      });
    }
    if (demanded.size === 0) return false;
    // Transforms replace blocks between waves, so index the live placeholders
    // anew in each pass. Searching every body again for each initializer makes
    // materializing large module registries quadratic in the program size.
    const placeholders = new Map<string, Extract<IrStmt, { kind: "block" }>[]>();
    const locationKey = (loc: IrStmt["loc"]): string =>
      JSON.stringify([loc.file, loc.start, loc.end]);
    const indexPlaceholders = (body: IrStmt[]): void => {
      everyStmtList(body, {
        stmt: (statement) => {
          if (statement.kind === "block" && statement.body.length === 0) {
            const key = locationKey(statement.loc);
            const blocks = placeholders.get(key) ?? [];
            blocks.push(statement);
            placeholders.set(key, blocks);
          }
          return true;
        },
        expr: () => true,
      });
    };
    for (const fn of functions) indexPlaceholders(fn.body);
    for (const id of demanded) {
      const initialize = this.pending.get(id)!;
      this.pending.delete(id);
      for (const action of initialize) {
        const body = action.lower();
        let inserted = false;
        for (const block of placeholders.get(locationKey(action.loc)) ?? []) {
          if (block.body.length === 0) {
            block.body.push(...body);
            inserted = true;
          }
        }
        // An inserted body can introduce a placeholder needed by another
        // action in this pass. Unattached bodies are not part of the live IR.
        if (inserted) indexPlaceholders(body);
      }
    }
    return demanded.size !== 0;
  }
}

/** A read of a binding's current value: a plain read, or an update
 * (`n++`, `--n`) that reads before it writes. */
function readsBinding(expr: IrExpr): expr is IrExpr & { kind: "varRef" | "incDec" } {
  return expr.kind === "varRef" || expr.kind === "incDec";
}

function registryInitializer(
  lowerer: Lowerer,
  expression: ts.Expression,
  statement: ts.Statement,
): boolean {
  if (
    ts.isCallExpression(expression) &&
    ts.isPropertyAccessExpression(expression.expression) &&
    lowerer.stdlibGlobalMember(expression.expression, "Object") === "freeze"
  ) {
    if (
      !ts.isPropertyAccessExpression(expression.expression) ||
      lowerer.stdlibGlobalMember(expression.expression, "Object") !== "freeze" ||
      expression.arguments.nodes.length !== 1 ||
      !ts.isObjectLiteralExpression(expression.arguments.nodes[0]!)
    )
      return false;
    expression = expression.arguments.nodes[0]!;
  }
  const packageSource = npmStaticPackageOfPath(ts.getSourceFileOfNode(statement).fileName) !== null;
  const initialized = (declaration: ts.Node): boolean => {
    const source = ts.getSourceFileOfNode(declaration);
    return source === ts.getSourceFileOfNode(statement)
      ? ts.tokenStartOfNode(declaration) < ts.tokenStartOfNode(statement)
      : [...lowerer.initNameOf.keys()].indexOf(source) >= 0 &&
          [...lowerer.initNameOf.keys()].indexOf(source) <
            [...lowerer.initNameOf.keys()].indexOf(ts.getSourceFileOfNode(statement));
  };
  const callable = (callee: ts.Expression): boolean => {
    if (!ts.isIdentifier(callee)) return false;
    if (
      ["Array", "Float32Array", "Float64Array"].includes(callee.text) &&
      lowerer.isStdlibGlobal(callee, callee.text)
    )
      return true;
    const symbol = lowerer.resolveValueSymbol(callee);
    const declaration = symbol && symbol.valueDeclaration;
    if (!symbol || !declaration || !bindingNeverReassigned(lowerer, symbol, declaration))
      return false;
    if (ts.isFunctionDeclaration(declaration)) return true;
    if (ts.isClassDeclaration(declaration)) return initialized(declaration);
    return (
      ts.isVariableDeclaration(declaration) &&
      initialized(declaration) &&
      !!declaration.initializer &&
      (ts.isArrowFunction(declaration.initializer) ||
        ts.isFunctionExpression(declaration.initializer))
    );
  };
  const value = (node: ts.Expression, depth = 0): boolean => {
    // Let ordinary expression lowering report its named depth limit.
    // Registry discovery must not overflow before that check runs.
    if (depth > 200) return false;
    if (ts.isParenthesizedExpression(node)) return value(node.expression, depth + 1);
    if (
      ts.isPrefixUnaryExpression(node) &&
      (node.operator === ts.SyntaxKind.MinusToken || node.operator === ts.SyntaxKind.PlusToken) &&
      ts.isNumericLiteral(node.operand)
    )
      return true;
    if (
      ts.isNumericLiteral(node) ||
      ts.isStringLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node) ||
      node.kind === ts.SyntaxKind.TrueKeyword ||
      node.kind === ts.SyntaxKind.FalseKeyword ||
      node.kind === ts.SyntaxKind.NullKeyword
    )
      return true;
    if (ts.isFunctionExpression(node) || ts.isArrowFunction(node)) return true;
    // Opted-in npm source retains the same PURE call contract as published
    // bundlers. Arguments still need to be safe to omit: an annotation
    // never licenses dropping argument effects or a throwing property read.
    if (packageSource && (ts.isCallExpression(node) || ts.isNewExpression(node))) {
      const trivia = ts.getSourceFileOfNode(node).text.slice(node.pos, ts.tokenStartOfNode(node));
      if (!/[@#]__PURE__/.test(trivia)) return false;
      if (!callable(node.expression)) return false;
      return (node.arguments?.nodes ?? []).every((argument) => value(argument, depth + 1));
    }
    if (
      ts.isPropertyAccessExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "prototype"
    ) {
      const info = exactClassOfReceiver(lowerer, node.expression.expression);
      return (
        !!info?.decl &&
        ts.getSourceFileOfNode(info.decl) === ts.getSourceFileOfNode(statement) &&
        ts.tokenStartOfNode(info.decl) < ts.tokenStartOfNode(statement) &&
        classWriteIsUnobserved(lowerer, info, statement) &&
        (findMethodOn(lowerer, info, node.name.text) !== null ||
          findGenericMethodOn(lowerer, info, node.name.text) !== null)
      );
    }
    if (packageSource && ts.isPropertyAccessExpression(node)) {
      const symbol = lowerer.checker.getSymbolAtLocation(node.name);
      const declaration = symbol && symbol.valueDeclaration;
      const owner = ts.isIdentifier(node.expression)
        ? lowerer.resolveValueSymbol(node.expression)
        : undefined;
      return (
        !!declaration &&
        ts.isPropertyAssignment(declaration) &&
        !ts.isComputedPropertyName(declaration.name) &&
        propertyName(declaration.name) !== "__proto__" &&
        !!owner &&
        registryOwnerIsData(lowerer, owner, statement) &&
        value(node.expression, depth + 1)
      );
    }
    if (ts.isArrayLiteralExpression(node))
      return node.elements.nodes.every(
        (element) => !ts.isSpreadElement(element) && value(element, depth + 1),
      );
    if (ts.isObjectLiteralExpression(node))
      return node.properties.nodes.every((property) => {
        if (
          ts.isMethodDeclaration(property) ||
          ts.isGetAccessorDeclaration(property) ||
          ts.isSetAccessorDeclaration(property)
        )
          return !!property.name && !ts.isComputedPropertyName(property.name);
        if (ts.isShorthandPropertyAssignment(property))
          return (
            !property.objectAssignmentInitializer &&
            ts.isIdentifier(property.name) &&
            value(property.name, depth + 1)
          );
        return (
          ts.isPropertyAssignment(property) &&
          !ts.isComputedPropertyName(property.name) &&
          (propertyName(property.name) !== "__proto__" ||
            property.initializer.kind === ts.SyntaxKind.NullKeyword) &&
          value(property.initializer, depth + 1)
        );
      });
    if (!ts.isIdentifier(node)) return false;
    if (node.text === "undefined" && lowerer.isStdlibGlobal(node, "undefined")) return true;
    if (
      ["Array", "Float32Array", "Float64Array"].includes(node.text) &&
      lowerer.isStdlibGlobal(node, node.text)
    )
      return true;
    const symbol = lowerer.resolveValueSymbol(node);
    const functionDeclaration = symbol && symbol.valueDeclaration;
    if (
      functionDeclaration &&
      ts.isFunctionDeclaration(functionDeclaration) &&
      ts.getSourceFileOfNode(functionDeclaration) === ts.getSourceFileOfNode(statement)
    )
      return true;
    // Reading an earlier initialized binding executes none of its
    // initializer. A deferred dependency is demanded by the emitted
    // varRef when this initializer becomes reachable.
    if (
      packageSource &&
      symbol &&
      functionDeclaration &&
      ts.isVariableDeclaration(functionDeclaration) &&
      functionDeclaration.initializer &&
      ts.getSourceFileOfNode(functionDeclaration) === ts.getSourceFileOfNode(statement) &&
      ts.tokenStartOfNode(functionDeclaration) < ts.tokenStartOfNode(statement)
    )
      return true;
    const info = symbol && lowerer.classBySymbol.get(symbol);
    const declaration = info?.decl;
    // Reading a class before its declaration can throw. Restrict this
    // optimization to earlier declarations in the same module; imports,
    // decorated classes and local factories keep ordinary initialization.
    return (
      !!declaration &&
      ts.getSourceFileOfNode(declaration) === ts.getSourceFileOfNode(statement) &&
      ts.tokenStartOfNode(declaration) < ts.tokenStartOfNode(statement) &&
      ts.isClassDeclaration(declaration) &&
      !info!.classDecorators &&
      !info!.generic &&
      !info!.localClass &&
      !info!.builtinError &&
      !info!.builtinEmitter &&
      !info!.builtinStream
    );
  };
  return value(expression);
}

function propertyName(name: ts.PropertyName): string | null {
  return ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)
    ? name.text
    : null;
}

/** A const binding alone does not make its properties pure: aliases,
 * descriptors and earlier writes can install a getter. Require an own
 * literal data property and no earlier mutation or escape of its owner. */
function registryOwnerIsData(
  lowerer: Lowerer,
  symbol: ts.Symbol,
  statement: ts.Statement,
): boolean {
  const declaration = symbol.valueDeclaration;
  if (
    !declaration ||
    !ts.isVariableDeclaration(declaration) ||
    !declaration.initializer ||
    !bindingNeverReassigned(lowerer, symbol, declaration)
  )
    return false;
  let initializer = declaration.initializer;
  const frozen =
    ts.isCallExpression(initializer) &&
    ts.isPropertyAccessExpression(initializer.expression) &&
    lowerer.stdlibGlobalMember(initializer.expression, "Object") === "freeze" &&
    initializer.arguments.nodes.length === 1;
  if (frozen) initializer = (initializer as ts.CallExpression).arguments.nodes[0]!;
  if (
    !ts.isObjectLiteralExpression(initializer) ||
    !initializer.properties.nodes.every(
      (property) =>
        ts.isShorthandPropertyAssignment(property) ||
        (ts.isPropertyAssignment(property) &&
          !ts.isComputedPropertyName(property.name) &&
          (propertyName(property.name) !== "__proto__" ||
            property.initializer.kind === ts.SyntaxKind.NullKeyword)),
    )
  )
    return false;
  if (ts.getSourceFileOfNode(declaration) !== ts.getSourceFileOfNode(statement)) {
    const modules = [...lowerer.initNameOf.keys()];
    return (
      !!frozen &&
      modules.indexOf(ts.getSourceFileOfNode(declaration)) >= 0 &&
      modules.indexOf(ts.getSourceFileOfNode(declaration)) <
        modules.indexOf(ts.getSourceFileOfNode(statement))
    );
  }
  if (ts.tokenStartOfNode(declaration) >= ts.tokenStartOfNode(statement)) return false;
  if (frozen) return true;
  let safe = true;
  const visit = (node: ts.Node): void => {
    if (!safe || ts.tokenStartOfNode(node) >= ts.tokenStartOfNode(statement)) return;
    if (
      ts.isIdentifier(node) &&
      node !== declaration.name &&
      lowerer.resolveValueSymbol(node) === symbol
    ) {
      let access: ts.Node = node;
      while (ts.isPropertyAccessExpression(access.parent) && access.parent.expression === access)
        access = access.parent;
      const parent = access.parent;
      if (
        !parent ||
        access === node ||
        (ts.isBinaryExpression(parent) &&
          parent.left === access &&
          parent.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
          parent.operatorToken.kind <= ts.SyntaxKind.LastAssignment) ||
        (parent &&
          (ts.isPrefixUnaryExpression(parent) ||
            ts.isPostfixUnaryExpression(parent) ||
            ts.isDeleteExpression(parent) ||
            (ts.isCallExpression(parent) && parent.expression === access)))
      )
        safe = false;
    }
    ts.forEachChild(node, visit);
  };
  visit(ts.getSourceFileOfNode(statement));
  return safe;
}

/** Before a class registry write, arbitrary module effects can change its
 * static/prototype descriptors. Only adjacent declarations and pure
 * registry setup preserve the known setter-free target. */
function classWriteIsUnobserved(
  lowerer: Lowerer,
  info: ClassInfo,
  statement: ts.Statement,
): boolean {
  const source = ts.getSourceFileOfNode(statement);
  const declaration = info.decl!;
  if (
    declaration.members.nodes.some(
      (member) =>
        ts.isClassStaticBlockDeclaration(member) ||
        (ts.isPropertyDeclaration(member) &&
          member.initializer &&
          ts
            .getModifiers(member)
            ?.some((modifier) => modifier.kind === ts.SyntaxKind.StaticKeyword) &&
          !registryInitializer(lowerer, member.initializer, declaration as ts.Statement)),
    )
  )
    return false;
  for (const earlier of source.statements.nodes) {
    if (
      ts.tokenStartOfNode(earlier) <= ts.tokenStartOfNode(declaration) ||
      ts.tokenStartOfNode(earlier) >= ts.tokenStartOfNode(statement)
    )
      continue;
    if (
      ts.isFunctionDeclaration(earlier) ||
      ts.isInterfaceDeclaration(earlier) ||
      ts.isTypeAliasDeclaration(earlier) ||
      ts.isEmptyStatement(earlier)
    )
      continue;
    if (
      ts.isVariableStatement(earlier) &&
      earlier.declarationList.declarations.nodes.every(
        (binding) =>
          !binding.initializer || registryInitializer(lowerer, binding.initializer, earlier),
      )
    )
      continue;
    if (
      ts.isExpressionStatement(earlier) &&
      ts.isBinaryExpression(earlier.expression) &&
      earlier.expression.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isPropertyAccessExpression(earlier.expression.left) &&
      registryInitializer(lowerer, earlier.expression.right, earlier)
    ) {
      const target = earlier.expression.left.expression;
      const owner =
        ts.isPropertyAccessExpression(target) && target.name.text === "prototype"
          ? target.expression
          : target;
      if (exactClassOfReceiver(lowerer, owner) === info) continue;
    }
    return false;
  }
  return true;
}
