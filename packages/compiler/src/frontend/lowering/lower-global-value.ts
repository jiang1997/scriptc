import * as ts from "../ts7/adapter.js";
import { DYN, STRING, arrayOf, type IrExpr } from "../../ir/ir.js";
import { strLit } from "../../ir/build.js";
import { locOf } from "../program.js";
import type { Lowerer } from "./lowerer.js";
import { TEMPORAL_GLOBAL } from "../builtin-modules.js";

/** A stored global object has identity and survives module/function boundaries.
 * Known globals without a value implementation refuse at runtime; absent host
 * capabilities answer undefined. The checker supplies names, never values. */
export function lowerGlobalValue(lowerer: Lowerer, expr: ts.Expression): IrExpr {
  const loc = locOf(expr);
  // The temporal global is typed for the programs that name it (TS 7's
  // lib slice) but absent in Node 24: reads answer undefined.
  const names = lowerer.checker
    .getPropertiesOfType(lowerer.typeOf(expr))
    .map((property) => ts.symbolName(property))
    .filter((name) => name !== TEMPORAL_GLOBAL);
  return {
    kind: "libCall",
    fn: "global.native",
    args: [
      {
        kind: "arrayLit",
        elems: names.map((name) => strLit(name, loc)),
        type: arrayOf(STRING),
        loc,
      },
    ],
    type: DYN,
    loc,
  };
}
