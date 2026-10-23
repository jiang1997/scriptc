/* Inline-cache sites of the dynamic tier (two-tier design stage S4).
 *
 * Lowering builds every dynamic property access on a constant key as a
 * call to a generated helper (class-dynamic-dispatch.ts): a read
 * `%dyn.class.property.N(receiver)`, a write
 * `%dyn.class.property.N(receiver, value)` and a keyed read
 * `%dyn.class.computed.N(receiver, key)`. A helper starts with one branch
 * per compiled class whose capsules may reach it and ends with the generic
 * checked-dynamic operation on the receiver itself. The capsule branches
 * test capsule and class-object kinds only, so for an ordinary checked
 * object or array receiver a helper is exactly its generic tail: [[Get]]
 * (`dynKeyGet`) or [[Set]] (`dyn.keySet`) of the key.
 *
 * A call to such a helper from a dynamic-tier function is an inline-cache
 * site: the backend (backend/llvm/js-ic.ts) answers plain data properties
 * of shaped objects through the site's cache and calls the helper for
 * everything else, so the helper stays the single definition of the
 * operation's semantics. This module recognizes the helpers by structure,
 * never by name alone: a helper whose body is not exactly capsule branches
 * plus the generic tail is not a site. `dynInvoke` is a site too: its
 * method read on an ordinary object is a [[Get]] (outside module
 * initializers, see jsIcMethodSites).
 *
 * Static functions never contain sites (invariant I1): the backend only
 * consults this module for calls in dynamic-tier functions. */
import type { IrExpr, IrFunction, IrModule, IrStmt } from "./ir.js";
import { everyStmtList } from "./traverse.js";

export type JsIcSite =
  | { kind: "get"; key: string }
  | { kind: "set"; key: string }
  | { kind: "keyed" };

const CAPSULE_TESTS = new Set(["dyn.typedRefIs", "dyn.typedRefKeyIs", "dyn.classIs"]);

/** Classifies the helpers of a module once. */
export class JsIcSites {
  private readonly fns: ReadonlyMap<string, IrFunction>;
  private readonly sites = new Map<string, JsIcSite | null>();
  private readonly identities = new Map<string, boolean>();

  constructor(mod: Pick<IrModule, "functions">) {
    this.fns = new Map(mod.functions.map((fn) => [fn.name, fn]));
  }

  /** The cache site a direct call to `callee` is, or null. */
  site(callee: string): JsIcSite | null {
    let site = this.sites.get(callee);
    if (site === undefined) {
      const fn = this.fns.get(callee);
      site = fn ? this.classify(fn) : null;
      this.sites.set(callee, site);
    }
    return site;
  }

  private classify(fn: IrFunction): JsIcSite | null {
    if (!fn.name.startsWith("%dyn.class.")) return null;
    if (fn.async !== undefined || fn.generator !== undefined || fn.captures !== undefined)
      return null;
    if (fn.params.some((p) => p.type.kind !== "dyn")) return null;
    const receiver = fn.params[0]?.localId;
    if (receiver === undefined) return null;
    let i = 0;
    while (i < fn.body.length && this.capsuleBranch(fn.body[i]!, receiver)) i++;
    const tail = fn.body.slice(i);
    if (fn.params.length === 1) return this.getTail(tail, receiver);
    if (fn.params.length !== 2) return null;
    const second = fn.params[1]!.localId;
    return this.setTail(tail, receiver, second) ?? this.keyedTail(tail, receiver, second);
  }

  /** `varDecl bag = BAG(receiver); return [js.fromDyn](bag === receiver ?
   * dynKeyGet(bag, K) : dyn.bagGet(bag, K, receiver))`. */
  private getTail(tail: IrStmt[], receiver: string): JsIcSite | null {
    const [decl, ret] = tail;
    if (tail.length !== 2 || decl?.kind !== "varDecl" || ret?.kind !== "return") return null;
    if (decl.init === null || !this.bagOf(decl.init, receiver)) return null;
    const bag = decl.localId;
    const value = unwrapFromDyn(ret.value);
    if (value?.kind !== "ternary") return null;
    const { cond, then } = value;
    if (
      cond.kind !== "dynScalarEq" ||
      cond.negated === true ||
      !isVar(cond.left, bag) ||
      !isVar(cond.right, receiver) ||
      then.kind !== "dynKeyGet" ||
      !isVar(then.value, bag) ||
      then.key.kind !== "strLit"
    )
      return null;
    return { kind: "get", key: then.key.value };
  }

  /** `dyn.keySet(BAG(receiver), K, value); return`. */
  private setTail(tail: IrStmt[], receiver: string, value: string): JsIcSite | null {
    const [stmt, ret] = tail;
    if (tail.length !== 2 || stmt?.kind !== "exprStmt" || ret?.kind !== "return") return null;
    if (ret.value !== null) return null;
    const call = stmt.expr;
    if (call.kind !== "libCall" || call.fn !== "dyn.keySet" || call.args.length !== 3) return null;
    const [bag, key, stored] = call.args;
    if (!bag || !this.bagOf(bag, receiver) || key?.kind !== "strLit" || !isVar(stored, value))
      return null;
    return { kind: "set", key: key.value };
  }

  /** `if (typeof key === "symbol") return dynKeyGet(BAG(receiver), key);
   * if (receiver == null) return dynKeyGet(receiver, key);
   * const s = String(key); return dynKeyGet(BAG(receiver), s)`, each read
   * possibly under js.fromDyn. */
  private keyedTail(tail: IrStmt[], receiver: string, key: string): JsIcSite | null {
    const [symbol, nullish, decl, ret] = tail;
    if (tail.length !== 4) return null;
    if (!this.guard(symbol, "symbol", key, (read) => this.bagOf(read, receiver), key)) return null;
    if (!this.guard(nullish, "nullish", receiver, (read) => isVar(read, receiver), key))
      return null;
    if (decl?.kind !== "varDecl" || decl.init?.kind !== "libCall") return null;
    if (decl.init.fn !== "dyn.toStringCoerce" || !isVar(decl.init.args[0], key)) return null;
    if (ret?.kind !== "return") return null;
    const read = unwrapFromDyn(ret.value);
    if (read?.kind !== "dynKeyGet" || !isVar(read.key, decl.localId)) return null;
    if (!this.bagOf(read.value, receiver)) return null;
    return { kind: "keyed" };
  }

  private guard(
    s: IrStmt | undefined,
    test: "symbol" | "nullish",
    tested: string,
    object: (e: IrExpr) => boolean,
    key: string,
  ): boolean {
    if (s?.kind !== "if" || s.else_ !== null || s.then.length !== 1) return false;
    const { cond } = s;
    if (cond.kind !== "dynTest" || cond.test !== test || cond.negated === true) return false;
    if (!isVar(cond.value, tested)) return false;
    const ret = s.then[0]!;
    if (ret.kind !== "return") return false;
    const read = unwrapFromDyn(ret.value);
    return read?.kind === "dynKeyGet" && isVar(read.key, key) && object(read.value);
  }

  /** A branch that can only be taken for a capsule or class-object
   * receiver: `if (<capsule test>) { ... }` with no else. */
  private capsuleBranch(s: IrStmt, receiver: string): boolean {
    return s.kind === "if" && s.else_ === null && this.capsuleTest(s.cond, receiver);
  }

  private capsuleTest(e: IrExpr, receiver: string): boolean {
    if (e.kind === "libCall")
      return CAPSULE_TESTS.has(e.fn) && e.args[0] !== undefined && this.bagOf(e.args[0], receiver);
    if (e.kind === "ternary")
      return (
        this.capsuleTest(e.cond, receiver) && e.else_.kind === "boolLit" && e.else_.value === false
      );
    return false;
  }

  /** Whether `e` is the receiver itself for every ordinary object or array:
   * the receiver, or a chain of property-bag helpers applied to it. */
  private bagOf(e: IrExpr, receiver: string): boolean {
    if (isVar(e, receiver)) return true;
    return (
      e.kind === "call" &&
      e.args.length === 1 &&
      this.bagOf(e.args[0]!, receiver) &&
      this.identityHelper(e.callee)
    );
  }

  /** An early exit for values a class table never matches: `if (!<kind
   * test>(value)) return <value>`, with no else. A plain object takes it
   * and gets itself back. */
  private kindExit(s: IrStmt, param: string): boolean {
    if (s.kind !== "if" || s.else_ !== null || s.then.length !== 1) return false;
    const { cond } = s;
    if (cond.kind !== "dynTest" || cond.negated !== true || !isVar(cond.value, param)) return false;
    if (cond.test !== "classCapsule" && cond.test !== "funcKind") return false;
    const ret = s.then[0]!;
    return ret.kind === "return" && ret.value !== null && this.bagOf(ret.value, param);
  }

  /** A property-bag helper that returns its argument unless a capsule
   * branch is taken. */
  private identityHelper(name: string): boolean {
    const known = this.identities.get(name);
    if (known !== undefined) return known;
    this.identities.set(name, false); // a recursive chain is not an identity
    const fn = this.fns.get(name);
    let identity = false;
    if (
      fn &&
      name.startsWith("%dyn.class.") &&
      fn.params.length === 1 &&
      fn.params[0]!.type.kind === "dyn" &&
      fn.async === undefined &&
      fn.generator === undefined &&
      fn.captures === undefined
    ) {
      const param = fn.params[0]!.localId;
      const last = fn.body[fn.body.length - 1];
      identity =
        fn.body
          .slice(0, -1)
          .every((s) => this.capsuleBranch(s, param) || this.kindExit(s, param)) &&
        last?.kind === "return" &&
        last.value !== null &&
        this.bagOf(last.value, param);
    }
    this.identities.set(name, identity);
    return identity;
  }
}

function isVar(e: IrExpr | undefined | null, localId: string): boolean {
  return e?.kind === "varRef" && e.localId === localId;
}

function unwrapFromDyn(e: IrExpr | null | undefined): IrExpr | null {
  if (!e) return null;
  if (e.kind === "libCall" && e.fn === "js.fromDyn" && e.args.length === 1) return e.args[0]!;
  return e;
}

/** Whether a function holds a cache site: a call to a classified helper or
 * a method dispatch. */
export function hasJsIcSite(fn: IrFunction, sites: JsIcSites): boolean {
  const methods = jsIcMethodSites(fn.name);
  return !everyStmtList(fn.body, {
    expr: (e) =>
      !(
        (methods && e.kind === "dynInvoke") ||
        (e.kind === "call" && sites.site(e.callee) !== null)
      ),
    stmt: () => true,
  });
}

/** Whether method dispatch in a function goes through caches. Module
 * initializers (`%init.N`) run once, and the methods they call at top level
 * are overwhelmingly registrations on native handles (`worker.on(...)`,
 * `server.listen(...)`), which a cache never answers: they keep the plain
 * dispatch, so a typed program whose only dynamic code is such top-level
 * wiring links no dynamic-tier runtime. Property sites still cache there
 * (top-level loops over objects). */
export function jsIcMethodSites(fnName: string): boolean {
  return !fnName.startsWith("%init.");
}
