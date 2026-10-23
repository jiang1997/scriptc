import { F64, type IrExpr, type IrFunction, type IrModule, type IrStmt } from "./ir.js";

type SwitchCase = Extract<IrStmt, { kind: "switch" }>["cases"][number];
import { reparseExpr } from "./serialize.js";
import {
  everyExprChild,
  everyStmtChild,
  everyStmtList,
  transformExpr,
  transformStmt,
  transformStmtList,
  type IrTransform,
} from "./traverse.js";

/** Local number arrays the backend may store as int32 slots.
 *
 * A candidate is a local `number[]` of a synchronous function that no
 * other binding can hold and only compiled element operations reach:
 * every write of the local stores a fresh array (an array literal, or
 * `new Array(n).fill(v)`), and every read of it is the receiver of an
 * element read, write, state test, `length`, `push` or `pop` (a discarded
 * `pop` included), or the array of an element-reader helper call. The
 * array never reaches a runtime function that reads its slots, a library
 * call, a closure, a return or untyped code.
 *
 * Candidates are only proposed here. The int32 slot analysis
 * (int32-slots.ts) keeps the ones whose every stored element is a proven
 * int32 (never -0), assuming the candidates' own elements are int32s, at
 * a fixpoint, and the LLVM backend stores those as SCR_ELEM_I32. It keeps
 * the ones whose stores are exact integers but not all proven int32s as
 * int32 arrays with checked stores: SCR_ELEM_I32 until a store that is not
 * an int32 widens them to doubles in place. Their element-reader helper
 * calls are inlined first (rewriteCandidates), so no shared helper ever
 * receives an int32 array. */

/** Array methods a candidate may be the receiver of: the runtime paths
 * behind them read and write int32 slots through the double-valued slot
 * accessors. */
export const INT32_ARRAY_METHODS: ReadonlySet<string> = new Set([
  "length",
  "push",
  "pop",
  "getNumber",
]);

/** An element-reader helper (`%arr.idxOr.*`): `(a, i) => a's state at i is
 * a value ? the element : undefined`, as one returned ternary. */
export function isElementReader(fn: IrFunction): boolean {
  if (fn.params.length !== 2 || fn.body.length !== 1) return false;
  const [array, index] = fn.params;
  const ret = fn.body[0]!;
  if (array!.type.kind !== "array" || array!.type.elem.kind !== "f64") return false;
  if (index!.type.kind !== "f64" || ret.kind !== "return" || ret.value?.kind !== "ternary")
    return false;
  const isParam = (e: IrExpr, id: string): boolean => e.kind === "varRef" && e.localId === id;
  const { cond, then, else_ } = ret.value;
  return (
    cond.kind === "bin" &&
    cond.op === "===" &&
    cond.left.kind === "arrayState" &&
    isParam(cond.left.arr, array!.localId) &&
    isParam(cond.left.index, index!.localId) &&
    cond.right.kind === "numLit" &&
    cond.right.value === 1 &&
    then.kind === "unionWrap" &&
    then.value.kind === "arrayGet" &&
    isParam(then.value.arr, array!.localId) &&
    isParam(then.value.index, index!.localId) &&
    else_.kind === "unionWrap" &&
    else_.value.kind === "unitLit"
  );
}

/** `new Array(n).fill(v)` as lowering spells it: `fill` over a sequence
 * that declares a temporary empty array, sets its length and yields it. */
function fillAllocation(e: IrExpr): (IrExpr & { kind: "arrIntrinsic" }) | null {
  if (e.kind !== "arrIntrinsic" || e.method !== "fill" || e.receiver.kind !== "seqExpr")
    return null;
  const seq = e.receiver;
  const [decl, length] = seq.stmts;
  if (
    seq.stmts.length !== 2 ||
    decl?.kind !== "varDecl" ||
    decl.init?.kind !== "arrayLit" ||
    decl.init.elems.length !== 0 ||
    length?.kind !== "arraySetLength" ||
    length.arr.kind !== "varRef" ||
    length.arr.localId !== decl.localId ||
    seq.result.kind !== "varRef" ||
    seq.result.localId !== decl.localId
  )
    return null;
  return e;
}

/** Fill-form arrays shorter than this hold doubles even when they are int32
 * arrays with checked stores: their doubles fit a typical 32 KiB L1 data
 * cache, so 4-byte slots save no memory traffic. */
export const CHECKED_INT32_MIN_LENGTH = 4096;

/** The length `n` of `new Array(n).fill(v)`, or null for any other
 * allocation. */
export function fillAllocationLength(e: IrExpr): IrExpr | null {
  const fill = fillAllocation(e);
  if (!fill || fill.receiver.kind !== "seqExpr") return null;
  const set = fill.receiver.stmts[1]!;
  return set.kind === "arraySetLength" ? set.length : null;
}

/** A number expression whose evaluation has no effect: locals, literals and
 * arithmetic. */
function isPureLength(e: IrExpr): boolean {
  if (e.type.kind !== "f64") return false;
  switch (e.kind) {
    case "numLit":
    case "varRef":
      return true;
    case "bin":
      return e.left.type.kind === "f64" && isPureLength(e.left) && isPureLength(e.right);
    case "unary":
      return isPureLength(e.operand);
    default:
      return false;
  }
}

/** Whether the candidate `id` of `fn` may hold int32 slots with checked
 * stores: every array it is assigned is the fill form, with a length that
 * may reach CHECKED_INT32_MIN_LENGTH and evaluates without effects (the
 * backend evaluates it once more to pick the new array's kind). */
export function checkableInt32Allocations(fn: IrFunction, id: string): boolean {
  let ok = true;
  everyStmtList(fn.body, {
    stmt: (s) => {
      if ((s.kind === "varDecl" || s.kind === "assign") && s.localId === id) {
        const value = s.kind === "varDecl" ? s.init : s.value;
        const length = value ? fillAllocationLength(value) : null;
        if (
          length === null ||
          !isPureLength(length) ||
          (length.kind === "numLit" && length.value < CHECKED_INT32_MIN_LENGTH)
        )
          ok = false;
      }
      return ok;
    },
    expr: () => ok,
  });
  return ok;
}

/** A fresh number array: a literal without spreads, or the fill form. */
export function int32ArrayAllocation(e: IrExpr): boolean {
  return (e.kind === "arrayLit" && (e.spreads?.length ?? 0) === 0) || fillAllocation(e) !== null;
}

/** The array literal a candidate's allocation builds (the literal itself,
 * or the fill form's temporary's), and the fill form's temporary. */
export function allocatedLiteral(
  e: IrExpr,
): { literal: IrExpr & { kind: "arrayLit" }; temporary: string | null } | null {
  if (e.kind === "arrayLit") return { literal: e, temporary: null };
  const fill = fillAllocation(e);
  if (!fill || fill.receiver.kind !== "seqExpr") return null;
  const decl = fill.receiver.stmts[0]!;
  return decl.kind === "varDecl" && decl.init?.kind === "arrayLit"
    ? { literal: decl.init, temporary: decl.localId }
    : null;
}

/** `xs.pop()` whose value is unused, as lowering spells it: a sequence
 * that binds the array to a hidden local, then only reads that local's
 * length and truncates it with pop stores. Returns the hidden local and the
 * array read it binds. */
function discardedPop(e: IrExpr): { local: string; array: IrExpr & { kind: "varRef" } } | null {
  if (e.kind !== "seqExpr") return null;
  const [bind, ...rest] = e.stmts;
  if (bind?.kind !== "varDecl" || bind.init?.kind !== "varRef") return null;
  const local = bind.localId;
  const isLocal = (x: IrExpr): boolean => x.kind === "varRef" && x.localId === local;
  const expr = (x: IrExpr): boolean => {
    if (x.kind === "arrIntrinsic" && x.method === "length" && isLocal(x.receiver)) return true;
    return !isLocal(x) && everyExprChild(x, expr, stmt);
  };
  const stmt = (x: IrStmt): boolean => {
    if (x.kind === "arraySetLength" && x.pop === true && isLocal(x.arr)) return expr(x.length);
    return (
      !((x.kind === "varDecl" || x.kind === "assign") && x.localId === local) &&
      everyStmtChild(x, expr, stmt)
    );
  };
  return rest.every(stmt) && expr(e.result) ? { local, array: bind.init } : null;
}

/** Whether evaluating `e` may assign the local `id`. */
function writesLocal(e: IrExpr, id: string): boolean {
  const expr = (x: IrExpr): boolean =>
    !(x.kind === "assignExpr" && x.localId === id) && everyExprChild(x, expr, stmt);
  const stmt = (x: IrStmt): boolean =>
    !((x.kind === "varDecl" || x.kind === "assign") && x.localId === id) &&
    everyStmtChild(x, expr, stmt);
  return !expr(e);
}

/** The candidate locals of `fn` (see the module comment). */
export function int32ArrayCandidates(fn: IrFunction, readers: ReadonlySet<string>): Set<string> {
  const result = new Set<string>();
  if (fn.async || fn.generator) return result;
  const captured = new Set(
    [...(fn.captures ?? []), ...(fn.classCaptures ?? [])].map((c) => c.localId),
  );
  const params = new Set(fn.params.map((p) => p.localId));
  for (const local of fn.locals)
    if (
      local.type.kind === "array" &&
      local.type.elem.kind === "f64" &&
      !local.boxed &&
      !local.tdz &&
      !captured.has(local.id) &&
      !params.has(local.id)
    )
      result.add(local.id);
  if (result.size === 0) return result;
  const written = new Set<string>();
  // A receiver position: the candidate is read there without escaping.
  const receiver = (e: IrExpr): void => {
    if (e.kind !== "varRef") expr(e);
  };
  const expr = (e: IrExpr): boolean => {
    switch (e.kind) {
      case "varRef":
        result.delete(e.localId);
        return true;
      case "assignExpr":
        result.delete(e.localId);
        break;
      case "arrayGet":
      case "arrayState":
      case "arrayHas":
        receiver(e.arr);
        expr(e.index);
        return true;
      case "arrIntrinsic":
        if (!INT32_ARRAY_METHODS.has(e.method)) break;
        receiver(e.receiver);
        e.args.forEach(expr);
        return true;
      case "seqExpr": {
        // The pop's hidden local is the array itself; every use of it is a
        // length read or a pop store.
        const pop = discardedPop(e);
        if (!pop) break;
        e.stmts.slice(1).every(stmt);
        expr(e.result);
        return true;
      }
      case "call": {
        if (!readers.has(e.callee) || e.args.length !== 2) break;
        const [array, index] = e.args;
        // Inlining evaluates the index before the array read.
        if (array!.kind === "varRef" && writesLocal(index!, array!.localId))
          result.delete(array!.localId);
        receiver(array!);
        expr(index!);
        return true;
      }
    }
    return everyExprChild(e, expr, stmt);
  };
  const stmt = (s: IrStmt): boolean => {
    switch (s.kind) {
      case "varDecl":
      case "assign": {
        const value = s.kind === "varDecl" ? s.init : s.value;
        if (value && int32ArrayAllocation(value)) written.add(s.localId);
        else if (value) result.delete(s.localId);
        if (value) expr(value);
        return true;
      }
      case "arraySet":
        receiver(s.arr);
        expr(s.index);
        expr(s.value);
        return true;
      case "arraySetUndefined":
        // Stores a present undefined: a state, and a cleared (+0) slot.
        receiver(s.arr);
        expr(s.index);
        return true;
      case "forOf":
        result.delete(s.localId);
        break;
      case "tryCatch":
        if (s.catchLocalId) result.delete(s.catchLocalId);
        break;
    }
    return everyStmtChild(s, expr, stmt);
  };
  fn.body.every(stmt);
  for (const id of result) if (!written.has(id)) result.delete(id);
  return result;
}

/** The element values stored into each candidate: element writes, pushed
 * values, literal elements and fill values. */
export function int32ArrayStores(
  fn: IrFunction,
  candidates: ReadonlySet<string>,
): Map<string, IrExpr[]> {
  const stores = new Map<string, IrExpr[]>();
  const add = (id: string, value: IrExpr): void => {
    const list = stores.get(id);
    if (list) list.push(value);
    else stores.set(id, [value]);
  };
  const target = (e: IrExpr): string | null =>
    e.kind === "varRef" && candidates.has(e.localId) ? e.localId : null;
  const expr = (e: IrExpr): boolean => {
    if (e.kind === "arrIntrinsic" && e.method === "push") {
      const id = target(e.receiver);
      if (id !== null) for (const arg of e.args) add(id, arg);
    }
    return everyExprChild(e, expr, stmt);
  };
  const stmt = (s: IrStmt): boolean => {
    if ((s.kind === "varDecl" || s.kind === "assign") && candidates.has(s.localId)) {
      const value = s.kind === "varDecl" ? s.init : s.value;
      if (value?.kind === "arrayLit") for (const el of value.elems) add(s.localId, el);
      else if (value) {
        const fill = fillAllocation(value);
        if (fill) add(s.localId, fill.args[0]!);
      }
    }
    if (s.kind === "arraySet") {
      const id = target(s.arr);
      if (id !== null) add(id, s.value);
    }
    return everyStmtChild(s, expr, stmt);
  };
  fn.body.every(stmt);
  return stores;
}

/** Rewrite a function's candidates for the backend. A discarded pop uses
 * the candidate in place of its hidden local. An element-reader helper call
 * whose array is a candidate is inlined: the helper's returned ternary, with
 * the candidate for its array and the index for its index, so the read means
 * the same. An index that is not a plain read or literal is bound to a fresh
 * local first: in its own declaration just before the statement when the
 * call is the whole value of a declaration or assignment (the form lowering
 * gives `a[i]!`, and the one the backend reads without a box), otherwise in a
 * sequence around the ternary. Selection keeps out indexes that write the
 * array, so evaluating the index before the array read is unobservable. */
function rewriteCandidates(
  fn: IrFunction,
  candidates: ReadonlySet<string>,
  readers: ReadonlyMap<string, IrFunction>,
): IrFunction {
  const locals = [...fn.locals];
  let fresh = 0;
  const bind = (index: IrExpr): { decl: IrStmt; ref: IrExpr } => {
    const id = `%int32.read.${fresh++}`;
    locals.push({ id, name: id, type: F64, mutable: false });
    return {
      decl: { kind: "varDecl", localId: id, init: index, loc: index.loc },
      ref: { kind: "varRef", localId: id, type: F64, loc: index.loc },
    };
  };
  const readerCall = (e: IrExpr | null): (IrExpr & { kind: "call" }) | null =>
    e?.kind === "call" &&
    e.args.length === 2 &&
    readers.has(e.callee) &&
    e.args[0]!.kind === "varRef" &&
    candidates.has(e.args[0]!.localId)
      ? e
      : null;
  const simple = (e: IrExpr): boolean => e.kind === "varRef" || e.kind === "numLit";
  // The statements of a list, with complex read indexes declared first.
  const hoist = (list: IrStmt[]): IrStmt[] =>
    list.flatMap((s): IrStmt[] => {
      if (s.kind !== "varDecl" && s.kind !== "assign") return [s];
      const value = s.kind === "varDecl" ? s.init : s.value;
      const call = readerCall(value);
      if (!call || simple(call.args[1]!)) return [s];
      const { decl, ref } = bind(call.args[1]!);
      const read: IrExpr = { ...call, args: [call.args[0]!, ref] };
      if (s.kind === "varDecl") return [decl, { ...s, init: read }];
      return [decl, { ...s, value: read }];
    });
  const hoistCase = (c: SwitchCase): SwitchCase => ({ ...c, body: hoist(c.body) });
  const lists = (s: IrStmt): IrStmt => {
    switch (s.kind) {
      case "if":
        return { ...s, then: hoist(s.then), else_: s.else_ === null ? null : hoist(s.else_) };
      case "block":
        return { ...s, body: hoist(s.body) };
      case "while":
        return { ...s, body: hoist(s.body) };
      case "doWhile":
        return { ...s, body: hoist(s.body) };
      case "for":
        return { ...s, body: hoist(s.body) };
      case "forOf":
        return { ...s, body: hoist(s.body) };
      case "switch":
        return { ...s, cases: s.cases.map((c) => hoistCase(c)) };
      case "tryCatch":
        return {
          ...s,
          tryBody: hoist(s.tryBody),
          catchBody: s.catchBody === null ? null : hoist(s.catchBody),
          finallyBody: s.finallyBody === null ? null : hoist(s.finallyBody),
        };
    }
    return s;
  };
  // Hidden pop locals replaced by their candidate array.
  const popLocals = new Set<string>();
  const rewrite = (e: IrExpr): IrExpr => {
    const pop = discardedPop(e);
    if (e.kind === "seqExpr" && pop && candidates.has(pop.array.localId)) {
      popLocals.add(pop.local);
      const array = pop.array;
      const substitute: IrTransform = {
        expr: (x) =>
          x.kind === "varRef" && x.localId === pop.local ? { ...array, loc: x.loc } : x,
        stmt: (x) => x,
      };
      return {
        ...e,
        stmts: e.stmts.slice(1).map((x) => transformStmt(x, substitute)),
        result: transformExpr(e.result, substitute),
      };
    }
    const call = readerCall(e);
    if (!call) {
      if (e.kind === "seqExpr") return { ...e, stmts: hoist(e.stmts) };
      return e;
    }
    const helper = readers.get(call.callee)!;
    const array = call.args[0]!;
    const [arrayParam, indexParam] = helper.params;
    const ret = helper.body[0]!;
    if (ret.kind !== "return" || !ret.value) return e;
    let index = call.args[1]!;
    const stmts: IrStmt[] = [];
    if (!simple(index)) {
      const { decl, ref } = bind(index);
      stmts.push(decl);
      index = ref;
    }
    const operand = index;
    const body = transformExpr(reparseExpr(ret.value), {
      expr: (x) => {
        if (x.kind !== "varRef") return x;
        if (x.localId === arrayParam!.localId) return reparseExpr(array);
        if (x.localId === indexParam!.localId) return reparseExpr(operand);
        return x;
      },
      stmt: (x) => x,
    });
    // The ternary is a fresh copy (reparseExpr): it takes the call's location.
    const typed = body;
    typed.loc = e.loc;
    return stmts.length === 0
      ? typed
      : { kind: "seqExpr", stmts, result: typed, type: typed.type, loc: e.loc };
  };
  const body = transformStmtList(hoist(fn.body), { expr: rewrite, stmt: lists });
  if (fresh === 0 && popLocals.size === 0) return { ...fn, body };
  return { ...fn, body, locals: locals.filter((local) => !popLocals.has(local.id)) };
}

/** Propose the module's int32 array candidates (`function\0local` keys in
 * `int32ArrayCandidates`), only those in `keep` when given, and rewrite
 * their functions. */
export function markInt32ArrayCandidates(
  mod: IrModule,
  keep: ReadonlySet<string> | null = null,
): IrModule {
  if (mod.lib !== undefined) return mod;
  const readers = new Map<string, IrFunction>();
  for (const fn of mod.functions) if (isElementReader(fn)) readers.set(fn.name, fn);
  const names = new Set(readers.keys());
  const keys: string[] = [];
  const functions = mod.functions.map((fn) => {
    const candidates = int32ArrayCandidates(fn, names);
    for (const id of candidates)
      if (keep === null || keep.has(`${fn.name}\0${id}`)) keys.push(`${fn.name}\0${id}`);
      else candidates.delete(id);
    return candidates.size === 0 ? fn : rewriteCandidates(fn, candidates, readers);
  });
  return keys.length === 0 ? mod : { ...mod, functions, int32ArrayCandidates: keys };
}

/** The module the backend emits: rewritten for exactly the candidates the
 * int32 slot analysis (`prove`, returning its int32Arrays) keeps, so a
 * module without int32 arrays is `mod` itself. A dropped candidate's
 * rewrite is undone by marking again without it, until every candidate
 * marked is kept. */
export function selectInt32Arrays(
  mod: IrModule,
  prove: (marked: IrModule) => ReadonlySet<string>,
): IrModule {
  let keep: ReadonlySet<string> | null = null;
  for (let round = 0; round < 4; round++) {
    const marked = markInt32ArrayCandidates(mod, keep);
    if (marked === mod) return mod;
    const kept = prove(marked);
    const proposed = marked.int32ArrayCandidates ?? [];
    if (proposed.every((key) => kept.has(key))) return marked;
    keep = new Set(proposed.filter((key) => kept.has(key)));
  }
  return mod;
}
