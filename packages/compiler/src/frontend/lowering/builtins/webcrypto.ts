import * as ts from "../../ts7/adapter.js";
import { type Lowerer } from "../lowerer.js";
import { isJsSourceFile, locOf } from "../../program.js";
import { BOOL, DYN, type IrExpr, type IrLibFn } from "../../../ir/ir.js";
import { lowerDynObjectLiteral } from "../expressions/object-literals.js";
import { stdlibGlobalNameOf } from "../surfaces.js";
import { WEBCRYPTO_DYN_TYPES } from "../../type-mapper.js";

/* WebCrypto's HMAC slice (scr_webcrypto.c): `crypto.subtle.importKey`,
 * `sign`, `verify` and `digest` called on the crypto global (also through
 * globalThis) lower to runtime entry points that take the argument vector
 * as one dyn array and answer a promise, so Web IDL conversion, algorithm
 * normalization and every error stay Node-shaped at run time. CryptoKey
 * values are native handles; their type maps to dyn and their members
 * are handle reads. Other SubtleCrypto methods are refused by name. */

const SUBTLE_LOWERED: ReadonlyMap<string, IrLibFn> = new Map([
  ["importKey", "webcrypto.importKey"],
  ["sign", "webcrypto.sign"],
  ["verify", "webcrypto.verify"],
  ["digest", "webcrypto.digest"],
]);

const SUBTLE_HINT =
  "the native WebCrypto surface is crypto.subtle.importKey('raw', ...) for HMAC keys, sign and verify with HMAC, and digest with SHA-1, SHA-256, SHA-384 or SHA-512, each called directly on crypto.subtle";

/** Whether `node` is `crypto.subtle` on the WebCrypto global. */
function isSubtleReceiver(lowerer: Lowerer, node: ts.Expression): boolean {
  while (ts.isParenthesizedExpression(node)) node = node.expression;
  return (
    ts.isPropertyAccessExpression(node) &&
    !node.questionDotToken &&
    node.name.text === "subtle" &&
    stdlibGlobalNameOf(lowerer, node.expression) === "crypto"
  );
}

/** `crypto.subtle.<method>(...args)`: the lowered methods become their
 * libCall over the argument vector; every other method is refused. */
export function lowerWebCryptoCall(lowerer: Lowerer, call: ts.CallExpression): IrExpr | null {
  const callee = call.expression;
  if (!ts.isPropertyAccessExpression(callee) || !isSubtleReceiver(lowerer, callee.expression)) {
    return null;
  }
  const member = callee.name.text;
  const fn = SUBTLE_LOWERED.get(member);
  if (fn === undefined) lowerer.noLowering(`crypto.subtle.${member}`, callee, SUBTLE_HINT);
  if (callee.questionDotToken || call.questionDotToken) {
    lowerer.noLowering(`optional calls of crypto.subtle.${member}`, call, SUBTLE_HINT);
  }
  if (call.arguments.nodes.some(ts.isSpreadElement)) {
    lowerer.noLowering(`crypto.subtle.${member} with spread arguments`, call, SUBTLE_HINT);
  }
  // JsonWebKey imports are not implemented: a literal 'jwk' format is
  // refused here (the runtime refuses a computed one).
  const format = call.arguments.nodes[0];
  if (
    member === "importKey" &&
    format !== undefined &&
    ts.isStringLiteralLike(format) &&
    format.text === "jwk"
  ) {
    lowerer.noLowering("crypto.subtle.importKey with the 'jwk' key format", format, SUBTLE_HINT);
  }
  const loc = locOf(call);
  const args = call.arguments.nodes.map((arg) =>
    ts.isObjectLiteralExpression(arg)
      ? lowerDynObjectLiteral(lowerer, arg)
      : lowerer.lowerExprExpecting(arg, DYN),
  );
  return {
    kind: "libCall",
    fn,
    args: [{ kind: "dynArrLit", elems: args, type: DYN, loc }],
    type: { kind: "promise", inner: member === "verify" ? BOOL : DYN },
    loc,
  };
}

/** `v instanceof CryptoKey` against the global. */
export function lowerCryptoKeyInstanceof(
  lowerer: Lowerer,
  expr: ts.BinaryExpression,
): IrExpr | null {
  if (stdlibGlobalNameOf(lowerer, expr.right) !== "CryptoKey") return null;
  const value = lowerer.coerceInto(expr.left, lowerer.lowerExpr(expr.left), DYN);
  return {
    kind: "libCall",
    fn: "webcrypto.isCryptoKey",
    args: [value],
    type: BOOL,
    loc: locOf(expr),
  };
}

/** TypeScript reads of `crypto.subtle` and its members outside a direct
 * call: the global's dynamic object does not carry the lowered methods,
 * so a detached read is refused rather than answering a value without
 * them. JavaScript keeps the dynamic object's reads. */
export function fenceWebCryptoMember(
  lowerer: Lowerer,
  access: ts.PropertyAccessExpression | ts.ElementAccessExpression,
  use: "read" | "call",
): IrExpr | null {
  if (use !== "read" || !ts.isPropertyAccessExpression(access)) return null;
  if (isJsSourceFile(ts.getSourceFileOfNode(access))) return null;
  if (isSubtleReceiver(lowerer, access)) {
    lowerer.noLowering("crypto.subtle as a value", access, SUBTLE_HINT);
  }
  if (isSubtleReceiver(lowerer, access.expression)) {
    lowerer.noLowering(`crypto.subtle.${access.name.text} as a value`, access, SUBTLE_HINT);
  }
  return null;
}

/** Whether a checker type is one of the WebCrypto interfaces reached
 * through the crypto global's members (SubtleCrypto, CryptoKey and the
 * algorithm dictionaries). While `crypto` was typed `unknown` those member
 * reads were untyped, so JavaScript destructurings of them keep the
 * module-global path untyped bindings take. `Crypto` itself is excluded:
 * the global was `unknown`, which already mapped to dyn. */
export function isWebCryptoMemberType(lowerer: Lowerer, type: ts.Type): boolean {
  const symbol = type.getAliasSymbol() ?? type.getSymbol();
  return (
    symbol !== undefined &&
    ts.symbolName(symbol) !== "Crypto" &&
    WEBCRYPTO_DYN_TYPES.has(ts.symbolName(symbol)) &&
    lowerer.isStdlibSymbol(symbol)
  );
}
