import * as ts from "../../ts7/adapter.js";
import { type Lowerer } from "../lowerer.js";
import { locOf } from "../../program.js";
import { BOOL, DYN, type IrExpr } from "../../../ir/ir.js";
import { builtinImportOf } from "./module-bindings.js";

/* node:crypto's secret KeyObject is a native checked-dynamic handle
 * (scr_lib.c): the KeyObject type maps to dyn, its getters and methods
 * dispatch through the handle, and these helpers lower the class's uses
 * that a dyn value cannot answer by itself. */

/** Whether `node` names node:crypto's KeyObject class. */
export function isKeyObjectClass(lowerer: Lowerer, node: ts.Expression): boolean {
  const builtin = ts.isIdentifier(node)
    ? builtinImportOf(lowerer, node)
    : ts.isPropertyAccessExpression(node) && !node.questionDotToken
      ? lowerer.builtinMemberOf(node)
      : null;
  return builtin?.module === "crypto" && builtin.member === "KeyObject";
}

/** Whether a value's checker type is node:crypto's KeyObject. */
export function isKeyObjectValue(lowerer: Lowerer, node: ts.Expression): boolean {
  const type = lowerer.typeOf(node);
  const sym = type.getAliasSymbol() ?? type.getSymbol();
  return !!sym && ts.symbolName(sym) === "KeyObject" && lowerer.isStdlibSymbol(sym);
}

/** `v instanceof KeyObject`. */
export function lowerKeyObjectInstanceof(
  lowerer: Lowerer,
  expr: ts.BinaryExpression,
): IrExpr | null {
  if (!isKeyObjectClass(lowerer, expr.right)) return null;
  const value = lowerer.coerceInto(expr.left, lowerer.lowerExpr(expr.left), DYN);
  return { kind: "libCall", fn: "crypto.isKeyObject", args: [value], type: BOOL, loc: locOf(expr) };
}

const KEY_OBJECT_METHODS = new Set(["export", "equals", "toCryptoKey"]);

/** `key.export(...)`, `key.equals(...)` and `key.toCryptoKey(...)`: the
 * handle answers them as methods, so they dispatch through dynInvoke
 * rather than as a member read and a call. */
export function lowerKeyObjectCall(lowerer: Lowerer, call: ts.CallExpression): IrExpr | null {
  if (call.questionDotToken || !ts.isPropertyAccessExpression(call.expression)) return null;
  const access = call.expression;
  if (access.questionDotToken || !KEY_OBJECT_METHODS.has(access.name.text)) return null;
  if (!isKeyObjectValue(lowerer, access.expression)) return null;
  if (call.arguments.nodes.some(ts.isSpreadElement)) return null;
  return {
    kind: "dynInvoke",
    recv: lowerer.lowerExprExpecting(access.expression, DYN),
    method: access.name.text,
    calleeName: ts.getTextOfNode(access),
    args: call.arguments.nodes.map((arg) => lowerer.lowerExprExpecting(arg, DYN)),
    type: DYN,
    loc: locOf(call),
  };
}
