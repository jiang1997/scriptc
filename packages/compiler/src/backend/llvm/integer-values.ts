import type { IrExpr, IrType } from "../../ir/ir.js";
import type { IntegerRange } from "../../ir/integer-ranges.js";
import type { LlValue, LlvmEmitterContext, WideInteger } from "./expr-context.js";

export type LlInteger = NonNullable<LlValue["integer"]>;

/** Materialize a proven integer only at an integer consumer. The ordinary
 * double remains authoritative when there is no proof, and ToUint32 views
 * are reused only when the range proves they have not lost high bits. */
export function exactInteger(
  host: LlvmEmitterContext,
  value: LlValue,
  expr?: IrExpr,
): LlInteger | null {
  if (value.integer) {
    const range = expr ? host.integerRanges.get(expr) : null;
    return range
      ? {
          ...value.integer,
          range: {
            min: Math.max(value.integer.range.min, range.min),
            max: Math.min(value.integer.range.max, range.max),
          },
        }
      : value.integer;
  }
  if (expr?.kind === "numLit" && Number.isSafeInteger(expr.value) && !Object.is(expr.value, -0)) {
    return {
      name: String(expr.value),
      type: "i64",
      signed: expr.value < 0,
      range: { min: expr.value, max: expr.value },
    };
  }
  const range = expr ? host.integerRanges.get(expr) : null;
  if (!range) return null;
  if (value.uint32 !== undefined && range.min >= 0 && range.max <= 4294967295) {
    return { name: value.uint32, type: "i32", signed: false, range };
  }
  if (value.uint32 !== undefined && range.min >= -2147483648 && range.max <= 2147483647) {
    return { name: value.uint32, type: "i32", signed: true, range };
  }
  if (range.min >= -2147483648 && range.max <= 2147483647) {
    // An int32 conversion lets LLVM fold it with an int32 source's sitofp.
    const name = host.B.tmp();
    host.B.line(`${name} = fptosi double ${value.name} to i32`);
    return { name, type: "i32", signed: true, range };
  }
  const name = host.B.tmp();
  host.B.line(`${name} = fptosi double ${value.name} to i64`);
  return { name, type: "i64", signed: true, range };
}

/** Doubles hold every integer of smaller magnitude exactly. */
const EXACT_DOUBLES = 2 ** 53;
/** Wide views stay within this magnitude: a product of two int32s reaches
 * 2^62, one exact term of at most 2^53 may be added to it, and no i64
 * result wraps. */
const WIDE_BOUND = 2 ** 62 + 2 ** 53;
/** Array and string indexes are below 2^32 - 1: a wide view exact below
 * this many is exact at every index a length can admit. */
const INDEX_LIMIT = 2 ** 32;

function magnitude(range: IntegerRange): number {
  return Math.max(Math.abs(range.min), Math.abs(range.max));
}

/** The wide view of `l op r` for `+`, `-` and `*` when the exact operands
 * have no proven result range (their product or sum may pass 2^53).
 *
 * - A product of two exact integers equals its double whenever its
 *   magnitude is below 2^53: the double product of integers is exact there.
 * - A sum or difference of two exact integers likewise.
 * - A sum or difference of a wide view (exact below T) and an exact integer
 *   of magnitude at most B equals its double below min(T - B, 2^53): the
 *   view's magnitude is then below T, so its double is exact, and the
 *   double sum of two exact integers below 2^53 is exact.
 *
 * Every i64 result stays within 2^62 + 2^53 in magnitude, so none wraps. A view
 * exact below fewer than 2^32 helps no index and is not kept. */
export function wideArithmetic(
  host: LlvmEmitterContext,
  op: string,
  l: LlValue,
  li: LlInteger | null,
  r: LlValue,
  ri: LlInteger | null,
): WideInteger | null {
  if (op !== "+" && op !== "-" && op !== "*") return null;
  const view = (value: LlValue, integer: LlInteger | null): WideInteger | null =>
    integer
      ? { name: "", below: Infinity, bound: magnitude(integer.range) }
      : (value.wideInteger ?? null);
  const lv = view(l, li),
    rv = view(r, ri);
  if (!lv || !rv) return null;
  let below: number, bound: number;
  if (op === "*") {
    if (lv.below !== Infinity || rv.below !== Infinity) return null;
    below = EXACT_DOUBLES;
    bound = lv.bound * rv.bound;
  } else if (lv.below === Infinity && rv.below === Infinity) {
    below = EXACT_DOUBLES;
    bound = lv.bound + rv.bound;
  } else if (lv.below === Infinity || rv.below === Infinity) {
    const [exact, wide] = lv.below === Infinity ? [lv, rv] : [rv, lv];
    below = Math.min(wide.below - exact.bound, EXACT_DOUBLES);
    bound = exact.bound + wide.bound;
  } else return null;
  if (!(bound <= WIDE_BOUND) || below < INDEX_LIMIT) return null;
  const operand = (value: LlValue, integer: LlInteger | null): string =>
    integer ? widenInteger(host, integer) : value.wideInteger!.name;
  const left = operand(l, li),
    right = operand(r, ri);
  const name = host.B.tmp();
  host.B.line(
    `${name} = ${op === "+" ? "add" : op === "-" ? "sub" : "mul"} nsw i64 ${left}, ${right}`,
  );
  return { name, below, bound };
}

/** An i64 index for a consumer that compares it, unsigned, with a length or
 * capacity below 2^32 and takes the double's path otherwise: the exact
 * integer of `value`, or its wide view, which equals the double at every
 * such index. Null when the index needs the double round trip. */
export function indexInteger(
  host: LlvmEmitterContext,
  value: LlValue,
  expr?: IrExpr,
): string | null {
  const integer = exactInteger(host, value, expr);
  if (integer) return widenInteger(host, integer);
  const wide = value.wideInteger;
  return wide && wide.below >= INDEX_LIMIT ? wide.name : null;
}

export function widenInteger(host: LlvmEmitterContext, value: LlInteger): string {
  if (value.type === "i64") return value.name;
  const wide = host.B.tmp();
  host.B.line(`${wide} = ${value.signed ? "sext" : "zext"} i32 ${value.name} to i64`);
  return wide;
}

/** The i32 of an integer whose range is within int32. */
export function narrowInteger(host: LlvmEmitterContext, value: LlInteger): string {
  if (value.type === "i32") return value.name;
  const narrow = host.B.tmp();
  host.B.line(`${narrow} = trunc i64 ${value.name} to i32`);
  return narrow;
}

/** `integerNumber` for an i32 whose range is within int32. */
export function int32Number(
  host: LlvmEmitterContext,
  name: string,
  range: IntegerRange,
  type: IrType,
): LlValue {
  const number = host.B.tmp();
  host.B.line(`${number} = sitofp i32 ${name} to double`);
  return { name: number, type, uint32: name, integer: { name, type: "i32", signed: true, range } };
}

export function integerNumber(
  host: LlvmEmitterContext,
  name: string,
  range: IntegerRange,
  type: IrType,
): LlValue {
  const number = host.B.tmp();
  const uint32 = host.B.tmp();
  host.B.line(`${uint32} = trunc i64 ${name} to i32`);
  // A proven int32 converts from its low half. The value is the same, but
  // LLVM folds `fptosi (sitofp i32 x)` back to x, also through the phis of
  // loop-carried locals (whose other incoming values are int32 too, such as
  // `x | 0`), while a 64-bit source is not known to convert exactly. So a
  // counter written `i = (i + 1) | 0` stays an integer instead of taking a
  // double round trip on every iteration.
  const int32 = range.min >= -2147483648 && range.max <= 2147483647;
  host.B.line(
    int32
      ? `${number} = sitofp i32 ${uint32} to double`
      : `${number} = sitofp i64 ${name} to double`,
  );
  return { name: number, type, uint32, integer: { name, type: "i64", signed: true, range } };
}
