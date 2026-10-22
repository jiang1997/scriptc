import * as ts from "../../ts7/adapter.js";
import { type Lowerer, own } from "../lowerer.js";
import { locOf } from "../../program.js";
import { tryLowerExpression } from "../expressions/try-lower-expression.js";
import { programDeclaresDateClass } from "./date-classes.js";
import {
  BOOL,
  F64,
  type IrExpr,
  type IrLibFn,
  type IrStmt,
  type IrType,
  NULL_T,
  type SrcLoc,
  STRING,
  typeKey,
} from "../../../ir/ir.js";

const DATE_GETTER_FNS: Readonly<Record<string, IrLibFn>> = {
  getFullYear: "date.getFullYear",
  getUTCFullYear: "date.getUTCFullYear",
  getMonth: "date.getMonth",
  getUTCMonth: "date.getUTCMonth",
  getDate: "date.getDate",
  getUTCDate: "date.getUTCDate",
  getDay: "date.getDay",
  getUTCDay: "date.getUTCDay",
  getHours: "date.getHours",
  getUTCHours: "date.getUTCHours",
  getMinutes: "date.getMinutes",
  getUTCMinutes: "date.getUTCMinutes",
  getSeconds: "date.getSeconds",
  getUTCSeconds: "date.getUTCSeconds",
  getMilliseconds: "date.getMilliseconds",
  getUTCMilliseconds: "date.getUTCMilliseconds",
  getTimezoneOffset: "date.getTimezoneOffset",
};

const DATE_TEXT_FNS: ReadonlyMap<string, IrLibFn> = new Map([
  ["toString", "date.toString"],
  ["toDateString", "date.toDateString"],
  ["toTimeString", "date.toTimeString"],
]);

export const DATE_METHOD_HINT =
  "getTime(), valueOf(), toISOString(), toUTCString(), toJSON(), toString(), toDateString(), toTimeString(), the local/UTC calendar getters, and getTimezoneOffset() are supported; Date setters and locale formatters have no lowering";

/** The Date slice: statics plus read-only Date values backed by one
 * TimeClip'd millisecond scalar. Construction lives in lowerNew;
 * identity and mutating methods remain fenced. */
export function lowerDateCall(
  lowerer: Lowerer,
  call: ts.CallExpression,
  access: ts.PropertyAccessExpression,
): IrExpr | null {
  if (call.questionDotToken || access.questionDotToken) return null;
  const loc = locOf(call);
  const member = lowerer.stdlibGlobalMember(access, "Date");
  if (member === "now" || member === "parse" || member === "UTC")
    return lowerDateStaticCall(lowerer, call, member);
  if (lowerer.mapTypeOf(lowerer.typeOf(access.expression))?.kind !== "date") return null;
  if (!lowerer.isStdlibMember(access)) return null;
  const name = access.name.text;
  // A Date a JavaScript file constructs is a mutable object; setTime on
  // it takes the dynamic method call. So does every Date method on a
  // checked-dynamic receiver when the program declares a class that extends
  // Date: the value can be an instance, whose class may declare the method.
  if (
    (name === "setTime" || programDeclaresDateClass(lowerer)) &&
    tryLowerExpression(lowerer, access.expression)?.type.kind === "dyn"
  )
    return null;
  if (name === "toJSON") return lowerDateToJson(lowerer, call, access);
  if (call.arguments.nodes.length !== 0) {
    lowerer.noLowering(`Date.prototype.${name} with arguments`, call, DATE_METHOD_HINT);
  }
  const raw = lowerer.lowerExpr(access.expression);
  const receiver: IrExpr =
    raw.type.kind === "dyn"
      ? { kind: "libCall", fn: "date.checkedValue", args: [raw], type: { kind: "date" }, loc }
      : raw;
  if (receiver.type.kind !== "date")
    lowerer.badType(access.expression, lowerer.typeOf(access.expression));
  const result = dateValueMethod(name, receiver, loc);
  if (result) return result;
  lowerer.noLowering(
    `Date.prototype.${name}`,
    call,
    DATE_METHOD_HINT,
    lowerer.checker.getSymbolAtLocation(access.name),
  );
}

/** Date.now(), Date.parse(text) and Date.UTC(...), also called through a
 * class declared `extends Date`, which inherits them. Null for other
 * names. */
export function lowerDateStaticCall(
  lowerer: Lowerer,
  call: ts.CallExpression,
  name: string,
): IrExpr | null {
  const loc = locOf(call);
  if (name === "now") {
    if (call.arguments.nodes.length !== 0) {
      lowerer.noLowering(`Date.now with ${call.arguments.nodes.length} arguments`, call);
    }
    return { kind: "libCall", fn: "date.now", args: [], type: F64, loc };
  }
  // Date.parse uses the same date-string parser as new Date(dateString)
  // (V8's grammar in the runtime), so their NaN and TimeClip behavior agree.
  if (name === "parse") {
    if (call.arguments.nodes.length !== 1 || ts.isSpreadElement(call.arguments.nodes[0]!)) {
      lowerer.noLowering(`Date.parse with ${call.arguments.nodes.length} arguments`, call);
    }
    const input = lowerer.lowerExprExpecting(call.arguments.nodes[0]!, STRING);
    return { kind: "libCall", fn: "date.parse", args: [input], type: F64, loc };
  }
  // Date.UTC(year[, month[, date[, hours[, minutes[, seconds[, ms]]]]]]):
  // a pure function of its numbers — the runtime's MakeDay/MakeTime/
  // TimeClip. Omitted trailing arguments complete with the spec's
  // defaults (month 0, date 1, time parts 0); tsc pins every present
  // argument to number, so the seven-f64 ABI is exact.
  if (name === "UTC") {
    if (
      call.arguments.nodes.length < 1 ||
      call.arguments.nodes.length > 7 ||
      call.arguments.nodes.some((a) => ts.isSpreadElement(a))
    ) {
      lowerer.noLowering(`Date.UTC with ${call.arguments.nodes.length} arguments`, call);
    }
    const defaults = [0, 0, 1, 0, 0, 0, 0]; // year is always present (arity ≥ 1)
    const args: IrExpr[] = [];
    for (let i = 0; i < 7; i++) {
      const a = call.arguments.nodes[i];
      args.push(
        a !== undefined
          ? lowerer.lowerExprExpecting(a, F64)
          : { kind: "numLit", value: defaults[i]!, type: F64, loc },
      );
    }
    return { kind: "libCall", fn: "date.utc", args, type: F64, loc };
  }
  return null;
}

/** The Date methods without arguments that have a lowering, applied to the
 * time value `value` (a `date`): getTime, valueOf, toISOString,
 * toUTCString, the calendar getters and the text forms. Null for other
 * names. */
export function dateValueMethod(name: string, value: IrExpr, loc: SrcLoc): IrExpr | null {
  if (name === "getTime" || name === "valueOf") {
    return {
      kind: "libCall",
      fn: name === "getTime" ? "date.getTime" : "date.valueOf",
      args: [value],
      type: F64,
      loc,
    };
  }
  if (name === "toISOString") {
    return { kind: "libCall", fn: "date.toISOStringValue", args: [value], type: STRING, loc };
  }
  if (name === "toUTCString") {
    return { kind: "libCall", fn: "date.toUTCString", args: [value], type: STRING, loc };
  }
  const fn = own(DATE_GETTER_FNS, name);
  if (fn !== undefined) {
    return { kind: "libCall", fn, args: [value], type: F64, loc };
  }
  const textFn = DATE_TEXT_FNS.get(name);
  if (textFn !== undefined) {
    return { kind: "libCall", fn: textFn, args: [value], type: STRING, loc };
  }
  return null;
}

/** `d.toJSON(key?)`: Node answers null for an invalid date and the
 * `toISOString()` string otherwise, as `string | null` (the lib types say
 * `string`). The argument is evaluated and ignored, as the built-in does. */
function lowerDateToJson(
  lowerer: Lowerer,
  call: ts.CallExpression,
  access: ts.PropertyAccessExpression,
): IrExpr {
  const loc = locOf(call);
  if (call.arguments.nodes.length > 1 || call.arguments.nodes.some((a) => ts.isSpreadElement(a)))
    lowerer.noLowering(`Date.prototype.toJSON with ${call.arguments.nodes.length} arguments`, call);
  const raw = lowerer.lowerExpr(access.expression);
  const receiver: IrExpr =
    raw.type.kind === "dyn"
      ? { kind: "libCall", fn: "date.checkedValue", args: [raw], type: { kind: "date" }, loc }
      : raw;
  if (receiver.type.kind !== "date")
    lowerer.badType(access.expression, lowerer.typeOf(access.expression));
  const date = lowerer.declareHiddenLocal("%date", receiver.type);
  const stmts: IrStmt[] = [{ kind: "varDecl", localId: date.id, init: receiver, loc }];
  const key = call.arguments.nodes[0];
  if (key) stmts.push({ kind: "exprStmt", expr: lowerer.lowerExpr(key), loc });
  const value: IrExpr = { kind: "varRef", localId: date.id, type: receiver.type, loc };
  const time: IrExpr = { kind: "libCall", fn: "date.getTime", args: [value], type: F64, loc };
  const type = dateJsonType(lowerer);
  return {
    kind: "seqExpr",
    stmts,
    result: {
      kind: "ternary",
      // An invalid date's time value is NaN, the one value unequal to itself.
      cond: { kind: "bin", op: "!==", left: time, right: time, type: BOOL, loc },
      then: lowerer.coerceToExpected({ kind: "unitLit", unit: "null", type: NULL_T, loc }, type),
      else_: lowerer.coerceToExpected(
        { kind: "libCall", fn: "date.toISOStringValue", args: [value], type: STRING, loc },
        type,
      ),
      type,
      loc,
    },
    type,
    loc,
  };
}

/** `string | null`, the type of a Date's `toJSON()` result. */
export function dateJsonType(lowerer: Lowerer): IrType {
  const arms = [STRING, NULL_T].sort((a, b) => (typeKey(a) < typeKey(b) ? -1 : 1));
  return { kind: "union", unionId: lowerer.unions.intern(arms) };
}

/** A Date `toJSON()` call, or a binding initialized by one
 * (Lowerer.dateJsonBindings): its value can be null where the lib types
 * say string. */
export function isDateJsonSource(lowerer: Lowerer, node: ts.Node): boolean {
  while (ts.isParenthesizedExpression(node)) node = node.expression;
  if (ts.isIdentifier(node)) {
    const symbol =
      node.parent && ts.isShorthandPropertyAssignment(node.parent) && node.parent.name === node
        ? lowerer.checker.getShorthandAssignmentValueSymbol(node.parent)
        : lowerer.checker.getSymbolAtLocation(node);
    return symbol !== undefined && lowerer.dateJsonBindings.has(symbol);
  }
  if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)) return false;
  const access = node.expression;
  return (
    access.name.text === "toJSON" &&
    !node.questionDotToken &&
    !access.questionDotToken &&
    lowerer.mapTypeOf(lowerer.typeOf(access.expression))?.kind === "date" &&
    lowerer.isStdlibMember(access)
  );
}
