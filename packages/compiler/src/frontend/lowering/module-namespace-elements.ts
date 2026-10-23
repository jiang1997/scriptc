import { dynUndefinedExpr, strLit, varRef } from "../../ir/build.js";
import * as ts from "../ts7/adapter.js";
import {
  DYN,
  STRING,
  type IrExpr,
  type IrFunction,
  type IrStmt,
  type IrType,
} from "../../ir/ir.js";
import { locOf } from "../program.js";
import { newFnCtx, type Lowerer } from "./lowerer.js";

/** Computed namespace reads select live exports instead of copying a
 * namespace into a registry snapshot. Constructor registries may contain
 * unrelated classes with different native signatures. */
export function lowerModuleNamespaceElement(
  lowerer: Lowerer,
  expr: ts.ElementAccessExpression,
): IrExpr | null {
  const type = lowerer.mapTypeOf(lowerer.typeOf(expr.expression));
  if (type?.kind !== "moduleNs") return null;
  const source = lowerer.sourceFileOfModuleNamespace(type);
  if (!source) return null;
  const loc = locOf(expr);
  const name = `%module.element:${type.moduleId}`;
  if (!lowerer.liftedFns.some((fn) => fn.name === name)) {
    const context = newFnCtx(false, null, null, DYN);
    const previousClass = lowerer.currentClass;
    lowerer.currentClass = null;
    lowerer.fnStack.push(context);
    try {
      const body: IrStmt[] = [];
      const symbol = lowerer.checker.getSymbolAtLocation(source);
      for (const exported of symbol ? lowerer.checker.getExportsOfModule(symbol) : []) {
        const key = ts.symbolName(exported);
        const target =
          exported.flags & ts.SymbolFlags.Alias
            ? lowerer.checker.getAliasedSymbol(exported)
            : exported;
        if (!(target.flags & ts.SymbolFlags.Value)) continue;
        const declaration = target.valueDeclaration;
        const identifier = declaration?.name as ts.Node | undefined;
        if (!identifier || !ts.isIdentifier(identifier)) {
          lowerer.unsupported("SC1090", expr, "computed namespace reads of unnamed exports");
        }
        const value = lowerer.lowerExprExpecting(identifier, DYN);
        body.push({
          kind: "if",
          cond: {
            kind: "strEq",
            negated: false,
            left: varRef("key", STRING, loc),
            right: strLit(key, loc),
            type: { kind: "bool" },
            loc,
          },
          then: [{ kind: "return", value, loc }],
          else_: null,
          loc,
        });
      }
      body.push({ kind: "return", value: dynUndefinedExpr(loc), loc });
      const fn: IrFunction = {
        name,
        params: [
          { localId: "namespace", name: "namespace", type },
          { localId: "key", name: "key", type: STRING },
        ],
        returnType: DYN,
        locals: [
          { id: "namespace", name: "namespace", type, mutable: false },
          { id: "key", name: "key", type: STRING, mutable: false },
          ...context.locals,
        ],
        body,
        loc,
      };
      lowerer.liftedFns.push(fn);
    } finally {
      lowerer.fnStack.pop();
      lowerer.currentClass = previousClass;
    }
  }
  const receiver = lowerer.lowerExpr(expr.expression);
  const key = lowerer.lowerExpr(expr.argumentExpression);
  const text: IrExpr =
    key.type.kind === "string"
      ? key
      : {
          kind: "libCall",
          fn: "dyn.toStringCoerce",
          args: [lowerer.coerceInto(expr.argumentExpression, key, DYN)],
          type: STRING,
          loc,
        };
  return { kind: "call", callee: name, args: [receiver, text], type: DYN, loc };
}

/** A module namespace taken as an untyped value (`{ ...ns }`, `{ iso: ns }`
 * in JavaScript): an object holding each value export, keyed in the
 * namespace's sorted key order. The copy is exact while every export is a
 * binding that never changes after initialization (const, function or
 * class); null for other namespaces, which keep their fence. */
export function moduleNamespaceObject(
  lowerer: Lowerer,
  ns: IrExpr & { type: IrType & { kind: "moduleNs" } },
): IrExpr | null {
  const source = lowerer.sourceFileOfModuleNamespace(ns.type);
  if (!source) return null;
  const symbol = lowerer.checker.getSymbolAtLocation(source);
  if (!symbol) return null;
  const exports: { key: string; identifier: ts.Identifier }[] = [];
  let exact = true;
  // The module's resolved exports, which include `export *` members.
  for (const exported of lowerer.checker.getExportsOfModule(symbol)) {
    const key = ts.symbolName(exported);
    const target =
      exported.flags & ts.SymbolFlags.Alias ? lowerer.checker.getAliasedSymbol(exported) : exported;
    if (!(target.flags & ts.SymbolFlags.Value)) continue;
    const declaration = target.valueDeclaration;
    const identifier = declaration?.name as ts.Node | undefined;
    const immutable =
      declaration !== undefined &&
      (ts.isFunctionDeclaration(declaration) ||
        ts.isClassDeclaration(declaration) ||
        (ts.isVariableDeclaration(declaration) &&
          (ts.getCombinedNodeFlags(declaration) & ts.NodeFlags.Const) !== 0));
    if (!identifier || !ts.isIdentifier(identifier) || !immutable) {
      exact = false;
      break;
    }
    exports.push({ key, identifier });
  }
  if (!exact) return null;
  exports.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const name = `%module.object:${ns.type.moduleId}`;
  const loc = ns.loc;
  if (!lowerer.liftedFns.some((fn) => fn.name === name)) {
    const context = newFnCtx(false, null, null, DYN);
    const previousClass = lowerer.currentClass;
    lowerer.currentClass = null;
    lowerer.fnStack.push(context);
    try {
      const fields = exports.map(({ key, identifier }) => ({
        key: strLit(key, loc),
        value: lowerer.lowerExprExpecting(identifier, DYN),
      }));
      if (fields.some((field) => field.value.type.kind !== "dyn")) return null;
      const fn: IrFunction = {
        name,
        params: [],
        returnType: DYN,
        locals: [...context.locals],
        body: [{ kind: "return", value: { kind: "dynObjLit", fields, type: DYN, loc }, loc }],
        loc,
      };
      lowerer.liftedFns.push(fn);
    } finally {
      lowerer.fnStack.pop();
      lowerer.currentClass = previousClass;
    }
  }
  const call: IrExpr = { kind: "call", callee: name, args: [], type: DYN, loc };
  if (ns.kind === "moduleNsRef") return call;
  return {
    kind: "seqExpr",
    stmts: [{ kind: "exprStmt", expr: ns, loc }],
    result: call,
    type: DYN,
    loc,
  };
}
