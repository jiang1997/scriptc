/* Dense array loops: a versioned copy of an index loop over an array whose
 * length the loop never changes.
 *
 * `for (let i = 0; i < a.length; i++) b[i] = a[i] * 2` reads its bound from
 * `a`, and every element access at the counter normally tests the index
 * against the array's hole-free prefix bound (`filled`, see
 * dense-array-access.ts) before it touches the slot. When the loop provably
 * never changes `a.length` (ir/array-length-stability.ts) and never moves or
 * cuts the storage of the arrays it indexes, one test before the loop covers
 * every pass: if `a.length` is at most each indexed array's `filled` bound,
 * every counter value the loop can reach (at least 0, below `a.length`)
 * names a present value in dense storage. The fast copy then reads and
 * replaces those slots directly, which leaves LLVM a loop without
 * per-element branches (vectorizable where the body allows it). The same
 * test bounds `a.length` by 2^31 - 1, so the fast copy's counter is an int32.
 * Arrays longer than that are sparse in practice (a dense one would need
 * 16 GB of slots) and take the ordinary copy, as does every array with a
 * hole, present undefined or sparse storage below `a.length`. */

import type { IrExpr, IrLocal, IrStmt } from "../../ir/ir.js";
import type { IntegerRange } from "../../ir/integer-ranges.js";
import { preservesArrayLength } from "../../ir/array-length-stability.js";
import { everyExprChild, everyStmtChild } from "../../ir/traverse.js";
import type { LlvmEmitterContext } from "./expr-context.js";
import { loadArrCount, SCR_ARR_FIELD } from "./common.js";

export const INT32_MAX = 2147483647;

export interface DenseArrayLoop {
  /** The loop's counter binding. */
  counter: string;
  /** The array whose length bounds the counter. */
  length: IrExpr & { kind: "varRef" };
  /** Arrays whose accesses at the counter are proven to be inside the
   * hole-free prefix in the fast copy, with a read of each binding. */
  arrays: ReadonlyMap<string, IrExpr & { kind: "varRef" }>;
  /** The counter's range on every pass of the fast copy. */
  range: IntegerRange;
}

/** The fast copy duplicates the loop; keep the duplicated code small. */
const MAX_LOOP_NODES = 120;

/** How a matched integer loop bounds its counter below `length.length`. */
export interface DenseLoopShape {
  counter: string;
  length: IrExpr & { kind: "varRef" };
  /** The counter's proven range on every pass of the ordinary loop; the
   * fast copy keeps its minimum, which must be at least 0. */
  range: IntegerRange;
}

/** `length.length - c` (c an integer literal, 0 when absent). */
function lengthOffset(e: IrExpr): { receiver: IrExpr & { kind: "varRef" }; offset: number } | null {
  let offset = 0;
  if (
    e.kind === "bin" &&
    e.op === "-" &&
    e.right.kind === "numLit" &&
    Number.isSafeInteger(e.right.value)
  ) {
    offset = e.right.value;
    e = e.left;
  }
  return e.kind === "arrIntrinsic" &&
    e.method === "length" &&
    e.args.length === 0 &&
    e.receiver.kind === "varRef" &&
    e.receiver.type.kind === "array"
    ? { receiver: e.receiver, offset }
    : null;
}

/** The array bounding a counted loop's counter below its length: an
 * ascending loop compared below `a.length - c`, or a descending one starting
 * at `a.length - c` (c >= 1). */
export function countedDenseShape(
  loop: IrStmt & { kind: "for" },
  counted: {
    localId: string;
    start: IrExpr;
    limit: IrExpr;
    step: number;
    inclusive: boolean;
    range: IntegerRange;
  },
): DenseLoopShape | null {
  if (counted.range.min < 0) return null;
  if (counted.step > 0) {
    const bound = lengthOffset(counted.limit);
    if (!bound || bound.offset < (counted.inclusive ? 1 : 0)) return null;
    return { counter: counted.localId, length: bound.receiver, range: counted.range };
  }
  // The start is evaluated once, before the loop; the counter only falls.
  const start = lengthOffset(counted.start);
  if (!start || start.offset < 1 || loop.init?.kind !== "varDecl") return null;
  return { counter: counted.localId, length: start.receiver, range: counted.range };
}

/** Match the fast copy of a loop of the given shape. `initialized` holds the
 * bindings definitely assigned when the loop starts; `unaliased` the local
 * arrays no other binding holds. */
export function matchDenseArrayLoop(
  loop: IrStmt & { kind: "for" },
  shape: DenseLoopShape,
  locals: ReadonlyMap<string, IrLocal>,
  unaliased: ReadonlySet<string>,
  initialized: ReadonlySet<string>,
): DenseArrayLoop | null {
  const { counter, length } = shape;
  if (shape.range.min < 0 || !loop.cond) return null;
  let nodes = 0,
    nested = false;
  const candidates = new Map<string, IrExpr & { kind: "varRef" }>();
  // Arrays written, resized, or indexed other than at the counter by an
  // element write.
  const disturbed = new Set<string>();
  const access = (arr: IrExpr, index: IrExpr): void => {
    if (arr.kind === "varRef" && index.kind === "varRef" && index.localId === counter)
      candidates.set(arr.localId, arr);
  };
  const expr = (e: IrExpr): boolean => {
    if (++nodes > MAX_LOOP_NODES) return false;
    if (e.kind === "assignExpr" || e.kind === "incDec") disturbed.add(e.localId);
    if (e.kind === "arrayGet") access(e.arr, e.index);
    if (e.kind === "arrIntrinsic") {
      if (e.method === "getNumber" && e.args[0]) access(e.receiver, e.args[0]);
      else if (e.method !== "length" && e.receiver.kind === "varRef")
        disturbed.add(e.receiver.localId);
    }
    return everyExprChild(e, expr, stmt);
  };
  const stmt = (s: IrStmt): boolean => {
    if (++nodes > MAX_LOOP_NODES) return false;
    if (s.kind === "for" || s.kind === "while" || s.kind === "doWhile" || s.kind === "forOf")
      nested = true;
    if (s.kind === "assign" || s.kind === "varDecl") disturbed.add(s.localId);
    if (s.kind === "arraySet") {
      access(s.arr, s.index);
      if (s.arr.kind === "varRef" && (s.index.kind !== "varRef" || s.index.localId !== counter))
        disturbed.add(s.arr.localId);
    }
    return everyStmtChild(s, expr, stmt);
  };
  if (!loop.body.every(stmt) || !expr(loop.cond) || nested) return null;
  if (
    !preservesArrayLength(
      [loop.cond, ...loop.body],
      { receiver: length.localId, inRange: counter },
      locals,
      unaliased,
    )
  )
    return null;
  const arrays = new Map<string, IrExpr & { kind: "varRef" }>();
  for (const [id, ref] of candidates) {
    const local = locals.get(id);
    if (
      !local ||
      local.type.kind !== "array" ||
      local.boxed ||
      local.tdz ||
      disturbed.has(id) ||
      (id !== length.localId && !initialized.has(id))
    )
      continue;
    arrays.set(id, ref);
  }
  if (arrays.size === 0) return null;
  return {
    counter,
    length,
    arrays,
    range: { min: shape.range.min, max: Math.min(shape.range.max, INT32_MAX - 1) },
  };
}

/** The fast copy's entry test: the bounding length is at most 2^31 - 1 and
 * at most every indexed array's hole-free prefix bound. */
export function emitDenseLoopGuard(host: LlvmEmitterContext, loop: DenseArrayLoop): string {
  const B = host.B;
  const size = host.sizeType;
  const header = (array: string, field: number): string => {
    const ptr = B.tmp();
    B.line(`${ptr} = getelementptr inbounds %ScrArr, ptr ${array}, i32 0, i32 ${field}`);
    host.markMemoryPointer(ptr, "array:header");
    return ptr;
  };
  const receiver = host.emitStableReceiver(loop.length, []);
  const lenPtr = header(receiver.name, SCR_ARR_FIELD.len),
    len = B.tmp(),
    small = B.tmp();
  loadArrCount(host, len, lenPtr, host.fieldAliasAttachment(lenPtr));
  B.line(`${small} = icmp ule ${size} ${len}, ${INT32_MAX}`);
  let valid = small;
  for (const [id, ref] of loop.arrays) {
    const array = id === loop.length.localId ? receiver : host.emitStableReceiver(ref, []);
    const filledPtr = header(array.name, SCR_ARR_FIELD.filled),
      filled = B.tmp(),
      covered = B.tmp(),
      both = B.tmp();
    B.line(`${filled} = load i32, ptr ${filledPtr}${host.fieldAliasAttachment(filledPtr)}`);
    let bound = filled;
    if (size === "i64") {
      bound = B.tmp();
      B.line(`${bound} = zext i32 ${filled} to i64`);
    }
    B.line(`${covered} = icmp ule ${size} ${len}, ${bound}`);
    B.line(`${both} = and i1 ${valid}, ${covered}`);
    valid = both;
  }
  return valid;
}
