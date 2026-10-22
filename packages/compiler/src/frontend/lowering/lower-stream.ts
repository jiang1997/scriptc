import { keyedHelperName } from "./stable-names.js";
import { nodeThrowExpr, boolLit, numLit, strLit } from "../../ir/build.js";
import { isValueStream, valueStreamOf } from "./builtins/hash-stream.js";
import { InternalCompilerError } from "../../errors.js";
/* The node:stream lowering (the spoke-module pattern, like
 * lower-event-emitter.ts): construction of the five runtime stream classes
 * (`new Readable({ read() {} })` et al — the OPTIONS-OBJECT form), user
 * subclasses (`class My extends Readable { _read() {...} }` — the
 * underscore-override form: super(options) lowers to a stream.init
 * libCall over the already-allocated subclass struct, and overridden
 * underscore methods bind as compiler-synthesized wrapper closures that
 * dispatch through the vtable, so a further-derived override wins even
 * under an inherited constructor), the stream method surface
 * (push/read/pause/resume/pipe/write/end/destroy/...) on stream-rooted
 * receivers, the readableEnded-family property reads, and the per-base
 * FORCED event tuples the emitter spoke consults ('data' is one Buffer,
 * 'pipe'/'unpipe' one Readable, the lifecycle events empty — runtime-
 * emitted payloads must be typed without colliding with user events of
 * the same names on plain emitters; the 'error' forced-tuple precedent,
 * scoped per runtime base).
 *
 * THE TYPING STANCE. Chunks are BYTES: 'data' delivers Buffers, read()
 * answers `Buffer | null`, and push/write accept a Buffer or a utf8
 * string (converted at the call, Node's decodeStrings default).
 * objectMode, setEncoding, and non-utf8 encodings have no static story
 * yet and fence with their own words. Option callbacks (`read`, `write`,
 * `final`, `destroy`, `transform`, `flush`) lower as closures with a
 * LEADING `this` parameter — Node binds `this` to the stream when it
 * calls them, so method-shorthand bodies (`read() { this.push(...) }`)
 * resolve `this` to that parameter; the runtime passes the stream through
 * compiler-emitted invoke adapters. A callback may declare any PREFIX of
 * its Node signature (the emitter listener rule). */
import * as ts from "../ts7/adapter.js";
import type { Lowerer } from "./lowerer.js";
import { dynFallbackType } from "./lowerer.js";
import {
  accessorCall,
  classIteratorNextCall,
  classIteratorOf,
  classIteratorOpenCall,
  type ClassInfo,
  type ClassIteratorInfo,
} from "./lower-classes.js";
import { isJsSourceFile, locOf } from "../program.js";
import { newFnCtx, own } from "./lowerer.js";
import { appendImplicitUndefinedReturn } from "./function-returns.js";
import { bufEncoding, knownBufEncoding } from "./containers/bytes.js";
import { tryLowerExpression } from "./expressions/try-lower-expression.js";
import { sideEffectFreeOptionValue } from "./surfaces.js";
import { lowerDynObjectLiteral } from "./expressions/object-literals.js";
import { dynUndefinedExpr, varRef } from "../../ir/build.js";
import { genResultRecord } from "../type-mapper.js";
import { noteUntypedStreamFlow, requestGeneralStreamSurface } from "./general-streams.js";
import { dynNativeBranch } from "./dyn-streams.js";
import { bindingNeverReassigned } from "./binding-analysis.js";
import { extractIteratorValue, genStep, genValue, stepDrivable } from "./lower-generators.js";
import { LiftedFrame, driveGenerator } from "./containers/iterator-helpers.js";
import { lowerArrayIteratorValue, lowerStringIteratorValue } from "./iterator-adapters.js";
import {
  BOOL,
  DYN,
  F64,
  type IrExpr,
  type IrFunction,
  type IrLibFn,
  type IrLocal,
  type IrStmt,
  type IrType,
  RUNTIME_STREAM_CLASSES,
  STRING,
  type SrcLoc,
  VOID,
  arrayOf,
  BYTES_U8,
  canBoxFuncIntoDyn,
  canConvertToDyn,
  funcOf,
  typeEquals,
  typeKey,
  UNDEFINED_T,
} from "../../ir/ir.js";

const BYTES = BYTES_U8;

/** An expression that only reads bindings and properties (no calls,
 * assignments or construction): reading it a step later observes the
 * same values. */
function pureRead(node: ts.Expression): boolean {
  if (
    ts.isParenthesizedExpression(node) ||
    ts.isNonNullExpression(node) ||
    ts.isAsExpression(node)
  ) {
    return pureRead(node.expression);
  }
  if (ts.isIdentifier(node) || node.kind === ts.SyntaxKind.ThisKeyword) return true;
  if (ts.isPropertyAccessExpression(node)) return pureRead(node.expression);
  if (ts.isElementAccessExpression(node)) {
    return (
      (ts.isStringLiteral(node.argumentExpression) ||
        ts.isNumericLiteral(node.argumentExpression)) &&
      pureRead(node.expression)
    );
  }
  return false;
}

/** The stream sides of a receiver class: the nearest stream-class
 * ancestor's, or null off the stream hierarchy. */
export function streamSidesOf(
  lowerer: Lowerer,
  info: ClassInfo | undefined | null,
): "r" | "w" | "rw" | null {
  for (let c: ClassInfo | null = info ?? null; c; c = c.base) {
    if (c.builtinStream) return c.builtinStream;
  }
  return null;
}

/** The instance members the stream spoke owns on stream-rooted
 * receivers (the emitter members ride the base chain as usual). */
export const STREAM_API_MEMBERS: ReadonlySet<string> = new Set([
  "push",
  "unshift",
  "read",
  "pause",
  "resume",
  "isPaused",
  "setEncoding",
  "pipe",
  "unpipe",
  "destroy",
  "write",
  "end",
  "cork",
  "uncork",
  "setDefaultEncoding",
]);

/** The property names the stream spoke owns (lowerStreamProperty) — a
 * subclass field or accessor with one of these names would split-brain
 * against the runtime state, so collection fences them (the
 * EMITTER_API_MEMBERS precedent). */
export const STREAM_PROP_MEMBERS: ReadonlySet<string> = new Set([
  "readable",
  "readableEnded",
  "readableFlowing",
  "readableLength",
  "readableHighWaterMark",
  "readableObjectMode",
  "writable",
  "writableEnded",
  "writableFinished",
  "writableNeedDrain",
  "writableLength",
  "writableHighWaterMark",
  "writableCorked",
  "writableObjectMode",
  "destroyed",
  "closed",
  "errored",
  "allowHalfOpen",
]);

/** The underscore methods each runtime base consumes at construction
 * (option-callback name → method name). A stream subclass declaring an
 * underscore method OUTSIDE its base's set (a `_read` on a Transform,
 * `_writev`/`_construct` anywhere) is fenced at collection: Node would
 * consume it through machinery that has no lowering here. */
export const UNDERSCORE_METHODS: ReadonlyMap<string, string> = new Map([
  ["read", "_read"],
  ["write", "_write"],
  ["final", "_final"],
  ["destroy", "_destroy"],
  ["transform", "_transform"],
  ["flush", "_flush"],
]);

/** The completion callback's parameter position in each underscore
 * method that takes one (cbTuples' "fn" positions). */
export const STREAM_COMPLETION_CALLBACK_INDEX: ReadonlyMap<string, number> = new Map([
  ["_write", 2],
  ["_final", 0],
  ["_destroy", 1],
  ["_transform", 2],
  ["_flush", 0],
]);

/** The accepted option-callback names (canonical flag order) and the
 * duplex-shaped-head answer for one runtime stream class. */
export function streamCtorShape(cls: string): {
  fn: string;
  accepted: readonly string[];
  duplexShape: boolean;
} {
  switch (cls) {
    case "%Readable":
      return { fn: "readable", accepted: ["read", "destroy"], duplexShape: false };
    case "%Writable":
      return { fn: "writable", accepted: ["write", "final", "destroy"], duplexShape: false };
    case "%Duplex":
      return { fn: "duplex", accepted: ["read", "write", "final", "destroy"], duplexShape: true };
    case "%Transform":
      return { fn: "transform", accepted: ["transform", "flush", "destroy"], duplexShape: true };
    case "%PassThrough":
      return { fn: "passthrough", accepted: ["transform", "flush", "destroy"], duplexShape: true };
    default:
      throw new InternalCompilerError(`lowerer bug: streamCtorShape of ${cls}`);
  }
}

/** Names emitted internally by stream runtimes. A computed EventEmitter
 * name must not match one, even through an EventEmitter-typed stream upcast. */
export const STREAM_FORCED_EVENT_NAMES: ReadonlySet<string> = new Set([
  "data",
  "end",
  "close",
  "readable",
  "pause",
  "resume",
  "drain",
  "prefinish",
  "finish",
  "pipe",
  "unpipe",
  "open",
  "ready",
  "keypress",
]);

/** The per-base FORCED event tuples (runtime-emitted payloads): consulted
 * by the emitter spoke BEFORE the program-global table, so a stream's
 * 'data' never collides with a user event named 'data' on a plain
 * emitter. 'error' stays globally forced to the one-%Error tuple. */
export function streamForcedTuple(
  lowerer: Lowerer,
  info: ClassInfo | undefined | null,
  name: string,
): IrType[] | null {
  const sides = streamSidesOf(lowerer, info);
  if (!sides) return null;
  // 'open' (the fd) and 'ready' are fs.ReadStream / fs.WriteStream's
  // (scr_fs_stream.c).
  const readable: Record<string, IrType[]> = {
    data: [BYTES],
    end: [],
    close: [],
    readable: [],
    pause: [],
    resume: [],
    open: [F64],
    ready: [],
    // readline.emitKeypressEvents' (str, key), as checked-dynamic values
    keypress: [DYN, DYN],
  };
  const writable: Record<string, IrType[]> = {
    open: [F64],
    ready: [],
    drain: [],
    prefinish: [],
    finish: [],
    close: [],
    pipe: [{ kind: "object", className: "%Readable" }],
    unpipe: [{ kind: "object", className: "%Readable" }],
  };
  // own(), not `in`: `name` is a USER-written event name, and
  // `"toString" in readable` answers true through Object.prototype.
  if (sides === "r" || sides === "rw") {
    const tuple = own(readable, name);
    if (tuple) return tuple;
  }
  if (sides === "w" || sides === "rw") {
    const tuple = own(writable, name);
    if (tuple) return tuple;
  }
  return null;
}
/* ── option callbacks (the leading-`this` closures) ─────────────────── */

/** Lowers one option callback (method shorthand, function expression, or
 * arrow) into a closure whose lifted function takes the STREAM as a
 * leading `this` parameter. Method/function bodies bind `this` to it
 * (Node calls them stream-bound); arrows keep lexical `this` (the hidden
 * leading param is ABI-only). The declared parameters must be a
 * typeEquals PREFIX of the callback's Node signature. */
function lowerStreamCallback(
  lowerer: Lowerer,
  which: string,
  node: ts.MethodDeclaration | ts.FunctionExpression | ts.ArrowFunction,
  thisType: IrType,
  fullTuple: IrType[],
): IrExpr {
  const loc = locOf(node);
  const { shapes, funcType } = lowerer.lambdaSignature(node);
  if (node.modifiers?.nodes.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword)) {
    lowerer.unsupported("SC1090", node, `async stream '${which}' callbacks`);
  }
  if (funcType.params.length > fullTuple.length) {
    lowerer.noLowering(
      `a '${which}' callback declaring ${funcType.params.length} parameters where Node passes ${fullTuple.length}`,
      node,
      "stream option callbacks may declare a prefix of their Node signature",
    );
  }
  for (let i = 0; i < funcType.params.length; i++) {
    // A checked-dynamic parameter (the JS lane's implicitly-any
    // callbacks) takes whatever Node passes — the emitted invoke thunk
    // boxes each position by kind (the completion callback arrives as a
    // callable dyn whose glue dispatches to the runtime's *_done).
    if (funcType.params[i]!.kind === "dyn") continue;
    if (!typeEquals(funcType.params[i]!, fullTuple[i]!)) {
      lowerer.noLowering(
        `a '${which}' callback whose parameter ${i} is '${lowerer.fmt(funcType.params[i]!)}' where Node passes '${lowerer.fmt(fullTuple[i]!)}'`,
        node,
        "annotate the parameter with the Node signature's type (chunks are Buffers here)",
      );
    }
  }
  const fnName = lowerer.closureName(loc, `_${which}cb`);
  const fnCtx = newFnCtx(true, null, funcType, funcType.ret);
  lowerer.fnStack.push(fnCtx);
  try {
    // Method shorthand and function expressions see the stream as `this`
    // (Node binds it); arrows keep lexical `this`, so their slot is a
    // hidden ABI local no body reference can resolve to.
    const thisLocal = ts.isArrowFunction(node)
      ? lowerer.declareHiddenLocal("this", thisType)
      : lowerer.declareThis(thisType);
    const { params, prologue } = lowerer.declareParams(node.parameters.nodes, shapes);
    let body: IrStmt[];
    if (node.body !== undefined && ts.isBlock(node.body)) {
      body = lowerer.lowerStmts(node.body.statements.nodes);
    } else if (node.body !== undefined) {
      // Bare-expression bodies (`read: () => this.push(null)`): the value
      // is discarded when the signature returns void — Node ignores
      // option-callback results either way.
      const bodyExpr = node.body as ts.Expression;
      if (funcType.ret.kind === "void") {
        body = [{ kind: "exprStmt", expr: lowerer.lowerExpr(bodyExpr), loc: locOf(node.body) }];
      } else {
        const value = lowerer.lowerExpr(bodyExpr);
        body = [
          {
            kind: "return",
            value: lowerer.coerceInto(bodyExpr, value, funcType.ret),
            loc: locOf(node.body),
          },
        ];
      }
    } else {
      body = [];
    }
    body = [...prologue, ...body];
    appendImplicitUndefinedReturn(lowerer, body, funcType.ret, loc);
    const ctx = lowerer.ctx;
    const lifted: IrFunction = {
      name: fnName,
      params: [{ localId: thisLocal.id, name: "this", type: thisType }, ...params],
      returnType: funcType.ret,
      locals: ctx.locals,
      captures: ctx.captures!,
      body,
      loc,
    };
    lowerer.liftedFns.push(lifted);
    return {
      kind: "closure",
      fnName,
      captures: ctx.captureSources,
      type: funcOf([thisType, ...funcType.params], funcType.ret),
      loc,
    };
  } finally {
    lowerer.fnStack.pop();
  }
}

/* ── construction ─────────────────────────────────────────────────────── */

interface StreamOptions {
  hwmR: IrExpr;
  hwmW: IrExpr;
  autoDestroy: IrExpr;
  emitClose: IrExpr;
  allowHalfOpen: IrExpr;
  /** Duplex side toggles ({ readable: false } drops the readable half) —
   * compile-time literals only. */
  readableSide: boolean;
  writableSide: boolean;
  /** The readable-side `encoding` option (canonical name, literal-only):
   * lowered as a setEncoding immediately after construction (Node's
   * ReadableState builds the decoder up front; the buffer is empty at
   * that point, so the two are equivalent). */
  encoding: string | null;
  /** A LITERAL encoding/defaultEncoding spelling Node does not know: the
   * construction lowers to Node's runtime ERR_UNKNOWN_ENCODING TypeError
   * (the state constructors validate encodings up front). */
  badEncoding: string | null;
  /** A Readable's valid non-utf8 `defaultEncoding` (canonical): applied
   * as a follow-up readable.pushEncoding — push(string) decodes through
   * it (Node's Buffer.from(chunk, state.defaultEncoding)). */
  pushEncoding: string | null;
  /** The `signal` option's value: applied with stream.addAbortSignal
   * right after construction (Node's constructors call addAbortSignal
   * once the state exists), or null when absent. */
  signal: IrExpr | null;
  /** Present callbacks in canonical order with their flag bits. */
  flags: number;
  cbs: IrExpr[];
}

/** The full Node parameter tuples of the option callbacks, given the
 * concrete stream's `this` type. The trailing completion callbacks keep
 * whatever func type the checker contextually gave the user's parameter
 * (the emitted adapter constructs a matching closure), so only their
 * FUNC-ness is checked here. */
function cbTuples(lowerer: Lowerer): Record<string, (IrType | "fn")[]> {
  return {
    read: [F64],
    write: [BYTES, STRING, "fn"],
    final: ["fn"],
    destroy: [errorOrNull(lowerer), "fn"],
    transform: [BYTES, STRING, "fn"],
    flush: ["fn"],
  };
}

/** Interns a union from unsorted arms (the interner's identity is the
 * typeKey-SORTED arm list — mapType's canonicalization). */
function unionOf(lowerer: Lowerer, arms: IrType[]): IrType {
  const sorted = [...arms].sort((a, b) => (typeKey(a) < typeKey(b) ? -1 : 1));
  return { kind: "union", unionId: lowerer.unions.intern(sorted) };
}

function errorOrNull(lowerer: Lowerer): IrType {
  return unionOf(lowerer, [{ kind: "object", className: "%Error" }, { kind: "nullT" }]);
}

/** The program's property-mutated symbols (`opts.read = f`, `opts["x"]
 * op= v`, `delete opts.y`): a const-initialized options record whose
 * symbol appears here cannot be followed to its literal — the runtime
 * record and the compile-time walk would split-brain. Built once, lazily
 * (the emitterEvents pre-pass precedent); the scan is diagnostic-free. */
function propMutatedSymbols(lowerer: Lowerer): Set<ts.Symbol> {
  if (lowerer.streamPropMutatedSyms) return lowerer.streamPropMutatedSyms;
  const set = new Set<ts.Symbol>();
  const noteBase = (target: ts.Expression): void => {
    let base = target;
    while (ts.isPropertyAccessExpression(base) || ts.isElementAccessExpression(base)) {
      base = base.expression;
    }
    if (!ts.isIdentifier(base)) return;
    try {
      const sym = lowerer.resolveValueSymbol(base);
      if (sym) set.add(sym);
    } catch {
      /* not a candidate */
    }
  };
  for (const sf of lowerer.program.getImplementationSourceFiles()) {
    if (sf.isDeclarationFile) continue;
    const walk = (node: ts.Node): void => {
      ts.forEachChild(node, walk);
      if (
        ts.isBinaryExpression(node) &&
        node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
        node.operatorToken.kind <= ts.SyntaxKind.LastAssignment &&
        (ts.isPropertyAccessExpression(node.left) || ts.isElementAccessExpression(node.left))
      ) {
        noteBase(node.left);
      } else if (ts.isDeleteExpression(node)) {
        noteBase(node.expression);
      }
    };
    walk(sf);
  }
  lowerer.streamPropMutatedSyms = set;
  return set;
}

/** Follows a non-literal options argument to its compile-time object
 * literal: a chain of const-declared, initialized variables ending at an
 * object literal (`const opts = { read() {} }; new Readable(opts)`).
 * Lowering the SAME literal at every construction site is sound for
 * scoping — the declaration's scope is an ancestor of every use site, so
 * each identifier in a callback body resolves to the identical binding
 * and captures it the ordinary way — and sound for identity because a
 * followed symbol is checked against the program's property mutations
 * (propMutatedSymbols). Returns the argument unchanged when the chain
 * breaks; `undefined`/null arguments answer null (Node's `if (options)`
 * guard — all defaults). */
function followOptionsArg(
  lowerer: Lowerer,
  arg: ts.Expression | undefined,
): ts.Expression | null | undefined {
  let node: ts.Expression | undefined = arg;
  for (let hops = 0; node !== undefined && hops < 16; hops++) {
    if (ts.isObjectLiteralExpression(node)) return node;
    if (ts.isParenthesizedExpression(node)) {
      node = node.expression;
      continue;
    }
    if (node.kind === ts.SyntaxKind.NullKeyword) return null;
    if (!ts.isIdentifier(node)) return node;
    if (node.text === "undefined") return null;
    let sym: ts.Symbol | null;
    try {
      sym = lowerer.resolveValueSymbol(node);
    } catch {
      return node;
    }
    const decl = sym ? sym.valueDeclaration : undefined;
    if (!sym || !decl || !ts.isVariableDeclaration(decl) || decl.initializer === undefined)
      return node;
    if ((ts.getCombinedNodeFlags(decl) & ts.NodeFlags.Const) === 0) return node;
    if (propMutatedSymbols(lowerer).has(sym)) return node;
    node = decl.initializer;
  }
  return node;
}

/** A callback slot holding a VALUE instead of an inline function (`read:
 * common.mustCall(fn)`, `{ write: myWrite }`): the value adapts through
 * the checked-dynamic function boundary exactly like dyn listeners —
 * boxed to dyn (statically-typed functions via dynFrom, checked-dynamic
 * values as they are), then dynCheck'd into the all-dyn full Node tuple.
 * The emitted option thunk recognizes the THISLESS shape (its first
 * param is not the stream) and boxes each position by kind — the chunk
 * as dyn bytes, the error via the boundary's encoding, the completion
 * callback as a callable dyn whose glue reports to the runtime's *_done.
 * DIVERGENCE (SEMANTICS.md): Node binds `this` to the stream when it
 * calls option callbacks; a value adapted through the dyn boundary is
 * called with `this` undefined (the dyn call ABI carries no receiver) —
 * reference the stream through a lexical binding instead. */
function lowerStreamCallbackValue(
  lowerer: Lowerer,
  ctorName: string,
  which: string,
  node: ts.Expression,
  fullLen: number,
): IrExpr {
  const loc = locOf(node);
  const getRecord = (id: string) => lowerer.shapes.get(id);
  const getUnion = (id: string) => lowerer.unions.get(id);
  let t: IrType | null;
  try {
    const ct = lowerer.typeOf(node);
    t = lowerer.mapTypeOf(ct) ?? dynFallbackType(lowerer, node, ct);
  } catch {
    t = null;
  }
  let cbDyn: IrExpr;
  if (t?.kind === "dyn") {
    const v = lowerer.lowerExpr(node);
    cbDyn = v.type.kind === "dyn" ? v : { kind: "dynFrom", value: v, type: DYN, loc };
  } else if (t?.kind === "func") {
    const cb = lowerer.lowerExpr(node);
    // JavaScript globals may keep callable values in checked storage even
    // when the checker can describe their function signature.
    if (cb.type.kind === "dyn") {
      cbDyn = cb;
    } else if (cb.type.kind === "func" && canBoxFuncIntoDyn(cb.type, getRecord, getUnion)) {
      cbDyn = { kind: "dynFrom", value: cb, type: DYN, loc };
    } else {
      lowerer.noLowering(
        `the ${ctorName} option '${which}' with a function value of this signature`,
        node,
        "a callback value's own parameters and return must cross the checked-dynamic boundary — write the callback inline to keep it fully static",
      );
    }
  } else {
    lowerer.noLowering(
      `the ${ctorName} option '${which}' with a non-function value`,
      node,
      "the callback slot takes an inline function (fully static) or a function value that crosses the checked-dynamic boundary",
    );
  }
  const adapterT = funcOf(
    Array.from({ length: fullLen }, () => DYN),
    VOID,
  );
  return { kind: "dynCheck", value: cbDyn, type: adapterT, loc };
}

/** A checked-dynamic options VALUE (the JS lane's `super(options)`
 * forwarding a constructor parameter, `new Readable(dynVar)`): the
 * record's shape is runtime data, so the option walk runs in the runtime
 * (the `.newDyn`/`.initDyn` twins) with Node's own reading rules. Null
 * when the argument is not dyn-flavored (the static walk owns it). */
function dynOptionsValue(lowerer: Lowerer, arg: ts.Expression): IrExpr | null {
  const followed = followOptionsArg(lowerer, arg);
  if (followed === null || followed === undefined || ts.isObjectLiteralExpression(followed))
    return null;
  let t: IrType | null;
  try {
    const ct = lowerer.typeOf(followed);
    t = lowerer.mapTypeOf(ct) ?? dynFallbackType(lowerer, followed, ct);
  } catch {
    return null;
  }
  if (t?.kind !== "dyn") return null;
  const v = lowerer.lowerExpr(followed);
  return v.type.kind === "dyn" ? v : null;
}

/** @types/node declares the transform/flush completion callback as
 * `(error?: Error | null, data?: any) => void`. Outside objectMode Node
 * accepts only a Buffer, a string or nothing as `data`, so the callback
 * parameter is typed with that union while the option callback lowers: a
 * checked-dynamic value passed as `data` converts at the call. Returns the
 * pinned parameter symbol (the caller unpins it), or null when the
 * declared type needs no pin. */
function pinAnyDataCompletion(
  lowerer: Lowerer,
  which: string,
  fnNode: ts.MethodDeclaration | ts.FunctionExpression | ts.ArrowFunction,
): ts.Symbol | null {
  const index = which === "transform" ? 2 : which === "flush" ? 0 : -1;
  const param = index < 0 ? undefined : fnNode.parameters.nodes[index];
  if (param === undefined || !ts.isIdentifier(param.name) || param.dotDotDotToken) return null;
  const symbol = lowerer.checker.getSymbolAtLocation(param.name);
  if (!symbol || lowerer.stageSourceTypes.has(symbol)) return null;
  const declared = lowerer.paramShape(param).type;
  if (declared.kind !== "func" || declared.rest || declared.params[1]?.kind !== "dyn") return null;
  const data = unionOf(lowerer, [BYTES, STRING, { kind: "undefinedT" }]);
  lowerer.stageSourceTypes.set(
    symbol,
    funcOf([declared.params[0]!, data, ...declared.params.slice(2)], declared.ret),
  );
  return symbol;
}

/** Parses the options object literal of a stream constructor. `which`
 * names the callbacks this class accepts, in canonical flag order. */
function parseStreamOptions(
  lowerer: Lowerer,
  ctorName: string,
  arg: ts.Expression | undefined,
  thisType: IrType,
  accepted: readonly string[],
  loc: SrcLoc,
  /** Subclass construction: the wrapper closure for an overridden
   * underscore method, consulted for callbacks the options did not
   * provide (an options callback shadows the method, Node's instance-
   * property rule). */
  fallbackCb?: (name: string) => IrExpr | null,
): StreamOptions {
  const out: StreamOptions = {
    hwmR: numLit(-1, loc),
    hwmW: numLit(-1, loc),
    autoDestroy: boolLit(true, loc),
    emitClose: boolLit(true, loc),
    allowHalfOpen: boolLit(true, loc),
    readableSide: true,
    writableSide: true,
    encoding: null,
    badEncoding: null,
    pushEncoding: null,
    signal: null,
    flags: 0,
    cbs: [],
  };
  const followed = followOptionsArg(lowerer, arg);
  const optsLit = followed === null ? undefined : followed;
  if (optsLit !== undefined && !ts.isObjectLiteralExpression(optsLit)) {
    lowerer.noLowering(
      `new ${ctorName} with a non-literal options argument`,
      optsLit,
      "the options must be an object literal, inline or through const-initialized bindings (the callbacks lower as compile-time closures)",
    );
  }
  const tuples = cbTuples(lowerer);
  const present = new Map<string, IrExpr>();
  for (const prop of optsLit?.properties?.nodes ?? []) {
    const propName = ts.isSpreadAssignment(prop) ? undefined : prop.name;
    const name =
      propName && ts.isIdentifier(propName)
        ? propName.text
        : propName && ts.isStringLiteral(propName)
          ? propName.text
          : null;
    if (name === null) {
      lowerer.unsupported("SC1090", prop, `computed or spread members in ${ctorName} options`);
    }
    // Callback members: shorthand methods and function-valued properties.
    if (accepted.includes(name)) {
      let fnNode: ts.MethodDeclaration | ts.FunctionExpression | ts.ArrowFunction | null = null;
      if (ts.isMethodDeclaration(prop)) fnNode = prop;
      else if (
        ts.isPropertyAssignment(prop) &&
        (ts.isFunctionExpression(prop.initializer) || ts.isArrowFunction(prop.initializer))
      ) {
        fnNode = prop.initializer;
      }
      if (!fnNode) {
        // A callback VALUE (`read: common.mustCall(fn)`, `{ write:
        // myWrite }`, shorthand `{ read }`): adapt through the checked-
        // dynamic function boundary (the dyn-listener precedent).
        const valueNode = ts.isPropertyAssignment(prop)
          ? prop.initializer
          : ts.isShorthandPropertyAssignment(prop) && ts.isIdentifier(prop.name)
            ? prop.name
            : null;
        if (valueNode === null) {
          lowerer.noLowering(
            `the ${ctorName} option '${name}' as this member form`,
            prop,
            "write the callback inline (method shorthand or an inline function/arrow), or pass a function value",
          );
        }
        present.set(
          name,
          lowerStreamCallbackValue(lowerer, ctorName, name, valueNode, tuples[name]!.length),
        );
        continue;
      }
      const full = tuples[name]!.map((t) => (t === "fn" ? null : t));
      const pinned = pinAnyDataCompletion(lowerer, name, fnNode);
      try {
        // The completion-callback tail: typed by the checker contextually;
        // accept the user's declared func type as the tuple's entry so the
        // prefix check compares like with like.
        const { funcType } = lowerer.lambdaSignature(fnNode);
        const tuple: IrType[] = full.map((t, i) => {
          if (t !== null) return t;
          const declared = funcType.params[i];
          if (declared !== undefined && declared.kind !== "func" && declared.kind !== "dyn") {
            lowerer.noLowering(
              `a '${name}' callback whose parameter ${i} is '${lowerer.fmt(declared)}' where Node passes the completion callback`,
              fnNode!,
            );
          }
          return declared ?? funcOf([], VOID);
        });
        present.set(name, lowerStreamCallback(lowerer, name, fnNode, thisType, tuple));
      } finally {
        if (pinned) lowerer.stageSourceTypes.delete(pinned);
      }
      continue;
    }
    // `{ signal }` shorthand: the binding is the value.
    if (name === "signal" && ts.isShorthandPropertyAssignment(prop)) {
      if (ts.isIdentifier(prop.name)) out.signal = lowerer.lowerExprExpecting(prop.name, DYN);
      continue;
    }
    // Scalar options.
    if (!ts.isPropertyAssignment(prop)) {
      lowerer.unsupported(
        "SC1090",
        prop,
        `the ${ctorName} option '${name}' as a shorthand/method member`,
      );
    }
    const value = prop.initializer;
    switch (name) {
      case "highWaterMark": {
        const v = lowerer.lowerExprExpecting(value, F64);
        out.hwmR = v;
        out.hwmW = v;
        break;
      }
      case "readableHighWaterMark":
        out.hwmR = lowerer.lowerExprExpecting(value, F64);
        break;
      case "writableHighWaterMark":
        out.hwmW = lowerer.lowerExprExpecting(value, F64);
        break;
      case "autoDestroy":
        out.autoDestroy = lowerer.lowerExprExpecting(value, BOOL);
        break;
      case "emitClose":
        out.emitClose = lowerer.lowerExprExpecting(value, BOOL);
        break;
      case "allowHalfOpen":
        out.allowHalfOpen = lowerer.lowerExprExpecting(value, BOOL);
        break;
      case "objectMode":
      case "readableObjectMode":
      case "writableObjectMode": {
        // `objectMode: false` is the byte default — admit the literal.
        if (value.kind === ts.SyntaxKind.FalseKeyword) break;
        lowerer.noLowering(
          `${ctorName} in objectMode`,
          prop,
          "object-mode streams have no static chunk type yet — chunks are Buffers (utf8 strings convert at push/write)",
        );
        break;
      }
      case "decodeStrings": {
        if (value.kind === ts.SyntaxKind.TrueKeyword) break; // Node's default
        lowerer.noLowering(
          `${ctorName} with decodeStrings: false`,
          prop,
          "chunks always decode to Buffers here (Node's default)",
        );
        break;
      }
      case "encoding": {
        // The readable-side string-chunk mode: a literal encoding, folded
        // to its canonical name (Writable has no such option). A literal
        // spelling Node does not know is Node's RUNTIME rejection —
        // ERR_UNKNOWN_ENCODING at construction, not a compile fence.
        if (ctorName === "Writable") lowerer.noLowering(`the Writable option 'encoding'`, prop);
        {
          const t = lowerer.typeOf(value);
          if (t.isStringLiteralType() && knownBufEncoding(t.value) === undefined) {
            out.badEncoding = t.value;
            break;
          }
        }
        out.encoding = bufEncoding(lowerer, `the ${ctorName} option 'encoding'`, value);
        break;
      }
      case "defaultEncoding":
        // utf8 is the byte default — admit the literal. A literal Node
        // does not know throws ERR_UNKNOWN_ENCODING at construction (the
        // state ctor validates it), Node's ladder. On a pure Readable a
        // valid non-utf8 name governs how push(string) DECODES chunks
        // (Buffer.from(chunk, enc)) — lowered as a follow-up
        // readable.pushEncoding. The write-side meaning (what
        // write(string) does) stays fenced on the writable classes.
        {
          const t = lowerer.typeOf(value);
          if (t.isStringLiteralType() && (t.value === "utf8" || t.value === "utf-8")) break;
          if (t.isStringLiteralType() && knownBufEncoding(t.value) === undefined) {
            out.badEncoding = t.value;
            break;
          }
          if (t.isStringLiteralType() && ctorName === "Readable") {
            out.pushEncoding = knownBufEncoding(t.value)!;
            break;
          }
        }
        lowerer.noLowering(
          `the ${ctorName} option 'defaultEncoding'`,
          prop,
          "utf8 (the default) is the supported write-side string encoding",
        );
        break;
      case "signal": {
        // `if (options.signal) addAbortSignal(options.signal, this)`:
        // applied over the fresh stream, so the value is read after the
        // constructor — only values whose evaluation has no effects.
        if (value.kind === ts.SyntaxKind.NullKeyword) break;
        if (ts.isIdentifier(value) && value.text === "undefined") break;
        if (!sideEffectFreeOptionValue(value) && !pureRead(value)) {
          lowerer.noLowering(
            `the ${ctorName} option 'signal' with this value`,
            prop,
            "pass a variable or property read (const signal = controller.signal) — the signal is read after construction",
          );
        }
        out.signal = lowerer.lowerExprExpecting(value, DYN);
        break;
      }
      case "captureRejections": {
        // `false` is the default — admit the literal; the rejection-
        // capturing mode has no lowering (async listeners' promises are
        // abandoned unobserved).
        if (value.kind === ts.SyntaxKind.FalseKeyword) break;
        lowerer.noLowering(
          `the ${ctorName} option 'captureRejections'`,
          prop,
          "captureRejections has no lowering (listener rejections are not routed to 'error')",
        );
        break;
      }
      case "readable":
      case "writable": {
        // Duplex side toggles: compile-time literals only (they decide
        // which halves EXIST).
        if (ctorName !== "Duplex") {
          lowerer.noLowering(`the ${ctorName} option '${name}'`, prop);
        }
        if (value.kind === ts.SyntaxKind.TrueKeyword) break;
        if (value.kind === ts.SyntaxKind.FalseKeyword) {
          if (name === "readable") out.readableSide = false;
          else out.writableSide = false;
          break;
        }
        lowerer.noLowering(
          `the Duplex option '${name}' with a non-literal value`,
          prop,
          "the side toggles must be compile-time booleans",
        );
        break;
      }
      case "final": {
        lowerer.noLowering(
          `the ${ctorName} option 'final'`,
          prop,
          ctorName === "Transform"
            ? "a user final on a Transform replaces the _flush composition — no lowering yet"
            : "the final callback is supported on Writable and Duplex",
        );
        break;
      }
      case "construct":
        lowerer.noLowering(
          `the ${ctorName} option 'construct'`,
          prop,
          "deferred construction (_construct) is not lowered yet",
        );
        break;
      case "writev":
        lowerer.noLowering(
          `the ${ctorName} option 'writev'`,
          prop,
          "batched writes (_writev) are not lowered yet — writes deliver one chunk at a time",
        );
        break;
      default:
        lowerer.noLowering(`the ${ctorName} option '${name}'`, prop);
    }
  }
  // Canonical flag order = the accepted list's order. Options win over
  // overridden underscore methods (Node assigns options callbacks onto
  // the instance, shadowing the prototype method).
  for (let i = 0; i < accepted.length; i++) {
    const cb = present.get(accepted[i]!) ?? fallbackCb?.(accepted[i]!) ?? null;
    if (cb) {
      out.flags |= 1 << i;
      out.cbs.push(cb);
    }
  }
  return out;
}

/** The head + flags argument list of a stream construction/initialization
 * (shared by `new Readable({...})` and a subclass's super(options)),
 * plus the parsed `encoding` option (applied as a follow-up setEncoding). */
function streamCtorArgs(
  lowerer: Lowerer,
  cls: string,
  arg: ts.Expression | undefined,
  thisType: IrType,
  loc: SrcLoc,
  fallbackCb?: (name: string) => IrExpr | null,
): {
  args: IrExpr[];
  encoding: string | null;
  badEncoding: string | null;
  pushEncoding: string | null;
  signal: IrExpr | null;
} {
  const shape = streamCtorShape(cls);
  const o = parseStreamOptions(
    lowerer,
    cls.slice(1),
    arg,
    thisType,
    shape.accepted,
    loc,
    fallbackCb,
  );
  const head = shape.duplexShape
    ? [
        o.hwmR,
        o.hwmW,
        o.autoDestroy,
        o.emitClose,
        o.allowHalfOpen,
        boolLit(o.readableSide, loc),
        boolLit(o.writableSide, loc),
        numLit(o.flags, loc),
      ]
    : [cls === "%Writable" ? o.hwmW : o.hwmR, o.autoDestroy, o.emitClose, numLit(o.flags, loc)];
  return {
    args: [...head, ...o.cbs],
    encoding: o.encoding,
    badEncoding: o.badEncoding,
    pushEncoding: o.pushEncoding,
    signal: o.signal,
  };
}

/** `new Readable(opts?)` and friends — called from lowerNew once the
 * callee resolved to a builtin stream class. */
export function lowerStreamNew(lowerer: Lowerer, expr: ts.NewExpression, info: ClassInfo): IrExpr {
  const loc = locOf(expr);
  const cls = info.def.name;
  if (!RUNTIME_STREAM_CLASSES.has(cls)) lowerer.unsupported("SC1090", expr, `constructing ${cls}`);
  const thisType: IrType = { kind: "object", className: cls };
  const args = expr.arguments?.nodes ?? [];
  if (args.length > 1) {
    lowerer.noLowering(
      `new ${info.def.name.slice(1)} with ${args.length} arguments`,
      expr,
      "the supported form takes one options object",
    );
  }
  if (args[0] !== undefined) {
    const dynOpts = dynOptionsValue(lowerer, args[0]);
    if (dynOpts !== null) {
      return {
        kind: "libCall",
        fn: `${streamCtorShape(cls).fn}.newDyn` as IrLibFn,
        args: [dynOpts],
        type: thisType,
        loc,
      };
    }
  }
  const fn = `${streamCtorShape(cls).fn}.new` as IrLibFn;
  const parsed = streamCtorArgs(lowerer, cls, args[0], thisType, loc);
  if (parsed.badEncoding !== null) {
    // Node's state constructors validate encodings first: an unknown
    // spelling never constructs — the whole expression throws.
    return nodeThrowExpr(
      1,
      "ERR_UNKNOWN_ENCODING",
      `Unknown encoding: ${parsed.badEncoding}`,
      thisType,
      loc,
    );
  }
  let built: IrExpr = { kind: "libCall", fn, args: parsed.args, type: thisType, loc };
  if (parsed.pushEncoding !== null) {
    // { defaultEncoding }: chain the push-side decode default (the
    // setEncoding chaining shape — answers the receiver +1).
    built = {
      kind: "libCall",
      fn: "readable.pushEncoding",
      args: [built, strLit(parsed.pushEncoding, loc)],
      type: thisType,
      loc,
    };
  }
  if (parsed.encoding !== null) {
    // { encoding }: chain a setEncoding over the fresh stream (the operand
    // temp releases with the frame; setEncoding answers the receiver +1).
    built = {
      kind: "libCall",
      fn: "readable.setEncoding",
      args: [built, strLit(parsed.encoding, loc)],
      type: thisType,
      loc,
    };
  }
  if (parsed.signal === null) return built;
  // { signal }: addAbortSignal over the fresh stream (answers it +1).
  return {
    kind: "libCall",
    fn: "stream.addAbortSignal",
    args: [built, parsed.signal],
    type: thisType,
    loc,
  };
}

/** True when a value of Node's argument type `passed` widens implicitly
 * into the declared parameter type `declared` (one of its union arms, or a
 * sub-union of it). */
function widensInto(lowerer: Lowerer, passed: IrType, declared: IrType, loc: SrcLoc): boolean {
  if (declared.kind !== "union") return false;
  const probe: IrExpr = { kind: "varRef", localId: "%probe", type: passed, loc };
  return typeEquals(lowerer.coerceToExpected(probe, declared).type, declared);
}

/* ── user subclasses (`extends Readable`, the underscore-override form) ── */

/** The wrapper closure binding one overridden underscore method as the
 * runtime's option callback: a lifted (this, ...prefix) function whose
 * body calls the method — through the vtable when some strict subclass
 * overrides it (the ordinary devirtualization rule), so an inherited
 * constructor still binds the DYNAMIC class's override. The method may
 * declare any PREFIX of its Node signature (the option-callback rule). */
function streamMethodWrapper(
  lowerer: Lowerer,
  info: ClassInfo,
  which: string,
  methodName: string,
  thisType: IrType,
  loc: SrcLoc,
  blame: ts.Node,
): IrExpr | null {
  const found = lowerer.findMethodOn(info, methodName);
  if (!found) {
    // A DESCENDANT-only declaration (the base chain never declares it):
    // this constructor cannot see it, and binding nothing without a
    // diagnostic would diverge from Node (which dispatches through the prototype chain).
    if (lowerer.overrideBelow(info, methodName)) {
      lowerer.noLowering(
        `a subclass of ${info.def.name.replace(/^%/, "")} declaring '${methodName}' below a base whose constructor cannot see it`,
        blame,
        `declare '${methodName}' on the class whose constructor calls the stream super(), and override it below`,
      );
    }
    return null;
  }
  // An ABSTRACT underscore declaration with no concrete override the
  // devirtualization can reach: no implementation exists to bind (the
  // class itself is abstract, so this constructor only ever runs under a
  // subclass — which, if concrete, implements the method and flips
  // overrideBelow into the virtual branch below).
  if (found.sig.abstract === true && !lowerer.overrideBelow(info, methodName)) {
    lowerer.noLowering(
      `an abstract '${methodName}' declaration with no concrete implementation below ${info.def.name.replace(/^%/, "")}`,
      blame,
      `implement '${methodName}' on a subclass the program constructs`,
    );
    return null;
  }
  const tuples = cbTuples(lowerer);
  const full = tuples[which]!;
  const declared = found.sig.params;
  if (declared.length > full.length) {
    lowerer.noLowering(
      `a '${methodName}' method declaring ${declared.length} parameters where Node passes ${full.length}`,
      blame,
      "stream underscore methods may declare a prefix of their Node signature",
    );
  }
  const paramTypes: IrType[] = [];
  for (let i = 0; i < declared.length; i++) {
    const want = full[i]!;
    const got = declared[i]!;
    if (got.mode !== "required") {
      lowerer.noLowering(
        `a '${methodName}' method with optional or defaulted parameters`,
        blame,
        "declare the Node signature's parameters plainly (any prefix is fine)",
      );
    }
    if (got.type.kind === "dyn") {
      // The JS lane's implicitly-any parameters: the emitted invoke
      // thunk boxes each position by kind.
    } else if (want === "fn") {
      if (got.type.kind !== "func") {
        lowerer.noLowering(
          `a '${methodName}' method whose parameter ${i} is '${lowerer.fmt(got.type)}' where Node passes the completion callback`,
          blame,
        );
      }
    } else if (!typeEquals(got.type, want)) {
      // A declared supertype of what Node passes (`chunk: Buffer | string`)
      // is sound: the wrapper takes Node's value and widens it into the
      // declared parameter.
      if (widensInto(lowerer, want, got.type, loc)) {
        paramTypes.push(want);
        continue;
      }
      lowerer.noLowering(
        `a '${methodName}' method whose parameter ${i} is '${lowerer.fmt(got.type)}' where Node passes '${lowerer.fmt(want)}'`,
        blame,
        "annotate the parameter with the Node signature's type or a supertype of it (chunks are Buffers here)",
      );
    }
    paramTypes.push(got.type);
  }
  const ret = found.sig.ret;
  const fnName = lowerer.closureName(loc, `_${which}vt`);
  const funcType = funcOf([thisType, ...paramTypes], ret);
  lowerer.fnStack.push(newFnCtx(true, null, funcType, ret));
  try {
    const thisLocal = lowerer.declareThis(thisType);
    const params = [{ localId: thisLocal.id, name: "this", type: thisType }];
    const argRefs: IrExpr[] = [];
    for (let i = 0; i < paramTypes.length; i++) {
      const local = lowerer.declareHiddenLocal(`a${i}`, paramTypes[i]!);
      params.push({ localId: local.id, name: local.name, type: paramTypes[i]! });
      const arg: IrExpr = { kind: "varRef", localId: local.id, type: paramTypes[i]!, loc };
      const declaredType = declared[i]!.type;
      argRefs.push(
        typeEquals(arg.type, declaredType) ? arg : lowerer.coerceToExpected(arg, declaredType),
      );
    }
    const thisRef: IrExpr = { kind: "varRef", localId: thisLocal.id, type: thisType, loc };
    let call: IrExpr;
    if (lowerer.overrideBelow(info, methodName)) {
      lowerer.noteVirtualEdge(info, methodName);
      call = {
        kind: "virtualCall",
        className: info.def.name,
        method: methodName,
        args: [thisRef, ...argRefs],
        type: ret,
        loc,
      };
    } else {
      lowerer.noteEdge(`%${found.declarer.def.name}.${methodName}`);
      call = {
        kind: "call",
        callee: `%${found.declarer.def.name}.${methodName}`,
        args: [lowerer.upcastTo(thisRef, found.declarer.def.name), ...argRefs],
        type: ret,
        loc,
      };
    }
    const body: IrStmt[] =
      ret.kind === "void"
        ? [{ kind: "exprStmt", expr: call, loc }]
        : [{ kind: "return", value: call, loc }];
    appendImplicitUndefinedReturn(lowerer, body, ret, loc);
    const ctx = lowerer.ctx;
    lowerer.liftedFns.push({
      name: fnName,
      params,
      returnType: ret,
      locals: ctx.locals,
      captures: ctx.captures!,
      body,
      loc,
    });
    return { kind: "closure", fnName, captures: ctx.captureSources, type: funcType, loc };
  } finally {
    lowerer.fnStack.pop();
  }
}

/** `super(options?)` in a class whose direct base chain lands on a
 * runtime stream class: lowers to the stream.init libCall over `this`
 * (the emitted allocation already stamped the subclass vtable and
 * display name; the runtime builds the state block). Options parse
 * exactly like the construction form; overridden underscore methods on
 * the class chain fill callbacks the options leave unset. */
export function lowerStreamSuperCall(
  lowerer: Lowerer,
  info: ClassInfo,
  base: ClassInfo,
  argNodes: readonly ts.Expression[],
  thisLocal: { id: string },
  loc: SrcLoc,
  blame: ts.Node,
): IrStmt[] {
  const cls = base.def.name;
  const thisType: IrType = { kind: "object", className: info.def.name };
  if (argNodes.length > 1) {
    lowerer.noLowering(
      `super(...) with ${argNodes.length} arguments in a ${cls.slice(1)} subclass`,
      blame,
      "the supported form takes one inline options object (or none)",
    );
  }
  const shape = streamCtorShape(cls);
  const fallback = (name: string): IrExpr | null => {
    const methodName = UNDERSCORE_METHODS.get(name);
    return methodName
      ? streamMethodWrapper(lowerer, info, name, methodName, thisType, loc, blame)
      : null;
  };
  const thisRef = (): IrExpr => ({ kind: "varRef", localId: thisLocal.id, type: thisType, loc });
  if (argNodes[0] !== undefined) {
    const dynOpts = dynOptionsValue(lowerer, argNodes[0]);
    if (dynOpts !== null) {
      // The dyn-options twin: the runtime walks the record; the class's
      // overridden underscore methods ride as FALLBACK wrappers (an
      // options callback shadows them, Node's instance-property rule).
      let flags = 0;
      const cbs: IrExpr[] = [];
      for (let i = 0; i < shape.accepted.length; i++) {
        const cb = fallback(shape.accepted[i]!);
        if (cb) {
          flags |= 1 << i;
          cbs.push(cb);
        }
      }
      return [
        {
          kind: "exprStmt",
          expr: {
            kind: "libCall",
            fn: `${shape.fn}.initDyn` as IrLibFn,
            args: [thisRef(), dynOpts, numLit(flags, loc), ...cbs],
            type: VOID,
            loc,
          },
          loc,
        },
      ];
    }
  }
  const parsed = streamCtorArgs(lowerer, cls, argNodes[0], thisType, loc, fallback);
  if (parsed.badEncoding !== null) {
    // super(options) with an unknown literal encoding: the state ctor
    // rejects before any initialization, Node's ladder.
    return [
      {
        kind: "exprStmt",
        expr: nodeThrowExpr(
          1,
          "ERR_UNKNOWN_ENCODING",
          `Unknown encoding: ${parsed.badEncoding}`,
          VOID,
          loc,
        ),
        loc,
      },
    ];
  }
  const out: IrStmt[] = [
    {
      kind: "exprStmt",
      expr: {
        kind: "libCall",
        fn: `${shape.fn}.init` as IrLibFn,
        args: [thisRef(), ...parsed.args],
        type: VOID,
        loc,
      },
      loc,
    },
  ];
  if (parsed.pushEncoding !== null) {
    out.push({
      kind: "exprStmt",
      expr: {
        kind: "libCall",
        fn: "readable.pushEncoding",
        args: [thisRef(), strLit(parsed.pushEncoding, loc)],
        type: thisType,
        loc,
      },
      loc,
    });
  }
  if (parsed.encoding !== null) {
    out.push({
      kind: "exprStmt",
      expr: {
        kind: "libCall",
        fn: "readable.setEncoding",
        args: [thisRef(), strLit(parsed.encoding, loc)],
        type: thisType,
        loc,
      },
      loc,
    });
  }
  if (parsed.signal !== null) {
    out.push({
      kind: "exprStmt",
      expr: {
        kind: "libCall",
        fn: "stream.addAbortSignal",
        args: [thisRef(), parsed.signal],
        type: thisType,
        loc,
      },
      loc,
    });
  }
  return out;
}

/* ── the underscore-method assignment surface ─────────────────────────── */

/** `r._read = fn` / `w._write = fn` (and _final/_destroy/_transform/
 * _flush) on a stream-rooted receiver AFTER construction — Node assigns
 * an own property that shadows the prototype method and the machinery
 * calls through it from then on. Here the runtime slot the option
 * callbacks fill swaps its closure: the RHS lowers exactly like the
 * matching option callback (inline functions fully static with the
 * stream as `this`; function VALUES — common.mustCall(fn) — through the
 * checked-dynamic boundary with the documented this-undefined
 * divergence), and the next _read/_write/... dispatch uses it, Node's
 * own timing. Null when the LHS is not an underscore-method write on a
 * runtime-stream-rooted receiver (the caller's routes continue);
 * `_writev` and methods outside the receiver's base set keep pointed
 * fences (Node would consume them through unlowered machinery). */
export function lowerStreamUnderscoreAssign(
  lowerer: Lowerer,
  expr: ts.BinaryExpression,
): IrStmt | null {
  if (!ts.isPropertyAccessExpression(expr.left) || expr.left.questionDotToken) return null;
  const methodName = expr.left.name.text;
  if (!methodName.startsWith("_")) return null;
  const optionByMethod = new Map<string, string>();
  for (const [option, method] of UNDERSCORE_METHODS) optionByMethod.set(method, option);
  if (!optionByMethod.has(methodName) && methodName !== "_writev" && methodName !== "_construct")
    return null;
  const recv = tryLowerExpression(lowerer, expr.left.expression);
  if (!recv || recv.type.kind !== "object") return null;
  const info = lowerer.classes.get(recv.type.className);
  let base: ClassInfo | null = null;
  for (let c: ClassInfo | null = info ?? null; c; c = c.base) {
    if (RUNTIME_STREAM_CLASSES.has(c.def.name)) {
      base = c;
      break;
    }
  }
  if (!base) return null;
  const loc = locOf(expr);
  const cls = base.def.name;
  const clsName = cls.slice(1);
  if (methodName === "_writev" || methodName === "_construct") {
    lowerer.noLowering(
      `assigning '${methodName}' on a ${clsName}`,
      expr.left,
      methodName === "_writev"
        ? "batched writes (_writev) are not lowered yet — writes deliver one chunk at a time"
        : "deferred construction (_construct) is not lowered yet",
    );
  }
  const which = optionByMethod.get(methodName)!;
  const { accepted } = streamCtorShape(cls);
  if (!accepted.includes(which)) {
    lowerer.noLowering(
      `assigning '${methodName}' on a ${clsName}`,
      expr.left,
      `a ${clsName}'s machinery consumes ${accepted.map((a) => `'${UNDERSCORE_METHODS.get(a)}'`).join("/")} — '${methodName}' would ride machinery with no lowering here`,
    );
  }
  const thisType: IrType = recv.type;
  const tuples = cbTuples(lowerer);
  let cb: IrExpr;
  const rhs = expr.right;
  if (ts.isFunctionExpression(rhs) || ts.isArrowFunction(rhs)) {
    const full = tuples[which]!.map((t) => (t === "fn" ? null : t));
    const { funcType } = lowerer.lambdaSignature(rhs);
    const tuple: IrType[] = full.map((t, i) => {
      if (t !== null) return t;
      const declared = funcType.params[i];
      if (declared !== undefined && declared.kind !== "func" && declared.kind !== "dyn") {
        lowerer.noLowering(
          `a '${methodName}' callback whose parameter ${i} is '${lowerer.fmt(declared)}' where Node passes the completion callback`,
          rhs,
        );
      }
      return declared ?? funcOf([], VOID);
    });
    cb = lowerStreamCallback(lowerer, which, rhs, thisType, tuple);
  } else {
    cb = lowerStreamCallbackValue(lowerer, clsName, which, rhs, tuples[which]!.length);
  }
  const SET_FNS: Record<string, IrLibFn> = {
    read: "stream.setRead",
    write: "stream.setWrite",
    final: "stream.setFinal",
    destroy: "stream.setDestroy",
    transform: "stream.setTransform",
    flush: "stream.setFlush",
  };
  return {
    kind: "exprStmt",
    expr: { kind: "libCall", fn: SET_FNS[which]!, args: [recv, cb], type: VOID, loc },
    loc,
  };
}

/* ── the static surface (Readable.from) ───────────────────────────────── */

/** `Readable.from(iterable, options)`: string[] / Buffer[] sources
 * become a readable that pushes one element per _read (whole entries in
 * object mode, hwm 1), and a single string/Buffer argument is a
 * one-chunk stream (from.js's special case, the mode's default hwm). The
 * options lower when they are a literal of `objectMode` and
 * `highWaterMark`; the JS lane and `any` sources take the runtime's
 * checked-dynamic form. Called from the method-call chain once the
 * receiver resolved to a stream class value. */
export function lowerStreamStaticCall(
  lowerer: Lowerer,
  call: ts.CallExpression,
  access: ts.PropertyAccessExpression,
): IrExpr | null {
  if (call.questionDotToken || access.questionDotToken) return null;
  let symbol: ts.Symbol | null | undefined = null;
  if (ts.isIdentifier(access.expression)) {
    symbol = lowerer.resolveValueSymbol(access.expression);
  } else if (
    ts.isPropertyAccessExpression(access.expression) &&
    ts.isIdentifier(access.expression.name)
  ) {
    const memberSym = lowerer.checker.getSymbolAtLocation(access.expression.name);
    symbol =
      memberSym && memberSym.flags & ts.SymbolFlags.Alias
        ? lowerer.checker.getAliasedSymbol(memberSym)
        : memberSym;
  }
  if (!symbol) return null;
  const info = lowerer.builtinStreamInfoOf(symbol);
  if (!info) return null;
  const member = access.name.text;
  const loc = locOf(call);
  const cls = info.def.name;
  // Readable.toWeb's type-option ladder (JS sources): a provably-invalid
  // `type` throws Node's ERR_INVALID_ARG_VALUE before any web stream
  // exists; valid shapes keep the fence — the web bridge has no lowering.
  if (
    member === "toWeb" &&
    cls === "%Readable" &&
    call.arguments.nodes.length === 2 &&
    isJsSourceFile(ts.getSourceFileOfNode(call)) &&
    ts.isObjectLiteralExpression(call.arguments.nodes[1]!)
  ) {
    for (const p of call.arguments.nodes[1]!.properties.nodes) {
      if (ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && p.name.text === "type") {
        const t = lowerer.typeOf(p.initializer);
        if (t.isStringLiteralType() && t.value !== "bytes") {
          lowerer.lowerExpr(call.arguments.nodes[0]!); // evaluation order (the stream argument)
          return nodeThrowExpr(
            1,
            "ERR_INVALID_ARG_VALUE",
            `The property 'options.type' must be one of: 'bytes', undefined. Received '${t.value}'`,
            lowerer.mapTypeOf(lowerer.typeOf(call)) ?? DYN,
            loc,
          );
        }
      }
    }
  }
  if (member !== "from") {
    lowerer.noLowering(`${cls.slice(1)}.${member}`, call);
  }
  if (cls !== "%Readable") {
    lowerer.noLowering(`${cls.slice(1)}.from`, call, "Readable.from is the lowered form");
  }
  const args = call.arguments.nodes;
  if (args.length > 2) {
    lowerer.noLowering(
      `Readable.from with ${args.length} arguments`,
      call,
      "Readable.from(iterable, options) is the supported form",
    );
  }
  const type: IrType = { kind: "object", className: "%Readable" };
  const js = isJsSourceFile(ts.getSourceFileOfNode(call));
  const srcNode = args[0];
  const optsNode = args[1];
  const srcT = srcNode ? lowerer.mapTypeOf(lowerer.typeOf(srcNode)) : null;
  const typedElem = (t: IrType | null | undefined): "string" | "bytes" | null =>
    t?.kind === "string" ? "string" : t?.kind === "bytes" && t.elem === "u8" ? "bytes" : null;
  const single = typedElem(srcT);
  const elem = srcT?.kind === "array" ? typedElem(srcT.elem) : null;
  const opts = optsNode ? fromOptions(lowerer, optsNode) : { flags: 0, hwm: null };
  // A class whose [Symbol.iterator]() or [Symbol.asyncIterator]() is a
  // generator method: from.js calls the method when the stream is built,
  // then reads the generator like any other.
  const genMethod = srcT?.kind === "object" ? classGeneratorMethodOf(lowerer, srcT) : null;
  const genT = srcT?.kind === "generator" ? srcT : (genMethod?.gen ?? null);
  if (srcNode && genT && opts && fromGenChunk(lowerer, genT.yieldT)) {
    // A compiled generator: the runtime pulls it through interned helpers.
    const recv = lowerer.lowerExpr(srcNode);
    const gen =
      genMethod && srcT?.kind === "object"
        ? accessorCall(lowerer, srcT.className, genMethod.method, recv, [], genT, loc)
        : recv;
    const helpers = fromGenHelpers(lowerer, genT, loc);
    if (helpers) {
      const hwm = opts.hwm ? lowerer.lowerExprExpecting(opts.hwm, F64) : numLit(0, loc);
      return {
        kind: "libCall",
        fn: genT.async ? "readable.fromAsyncGen" : "readable.fromGen",
        args: [gen, ...helpers, numLit(opts.flags, loc), hwm],
        type,
        loc,
      };
    }
  }
  // from.js prefers Symbol.asyncIterator: a class declaring one takes the
  // async route.
  const asyncOpen =
    srcT?.kind === "object" &&
    lowerer.classes.has(srcT.className) &&
    lowerer.findMethodOn(lowerer.classes.get(srcT.className)!, "sym:asyncIterator") !== null;
  const cit = srcT?.kind === "object" && !asyncOpen ? classIteratorOf(lowerer, srcT) : null;
  if (srcNode && cit && opts && fromGenChunk(lowerer, cit.valueT)) {
    // A class iterable: from.js takes the iterator when the stream is
    // built (the typed [Symbol.iterator]() call here), and the runtime
    // pulls it through a checked-dynamic { next } object. Class iterators
    // declare no return() or throw(), so destroy calls neither.
    const recv = lowerer.lowerExpr(srcNode);
    const hwm = opts.hwm ? lowerer.lowerExprExpecting(opts.hwm, F64) : numLit(0, loc);
    return {
      kind: "libCall",
      fn: "readable.fromIter",
      args: [
        classIteratorObject(lowerer, cit, classIteratorOpenCall(lowerer, cit, recv, loc), loc),
        numLit(opts.flags, loc),
        hwm,
      ],
      type,
      loc,
    };
  }
  const acit = srcT?.kind === "object" && asyncOpen ? classAsyncIteratorOf(lowerer, srcT) : null;
  if (srcNode && acit && opts && fromGenChunk(lowerer, acit.valueT)) {
    const recv = lowerer.lowerExpr(srcNode);
    const hwm = opts.hwm ? lowerer.lowerExprExpecting(opts.hwm, F64) : numLit(0, loc);
    return {
      kind: "libCall",
      fn: "readable.fromAsyncIter",
      args: [classAsyncIteratorObject(lowerer, acit, recv, loc), numLit(opts.flags, loc), hwm],
      type,
      loc,
    };
  }
  if (srcNode && (single || elem) && opts) {
    const v = lowerer.lowerExpr(srcNode);
    const hwm = opts.hwm ? lowerer.lowerExprExpecting(opts.hwm, F64) : numLit(0, loc);
    const arr: IrExpr = single ? { kind: "arrayLit", elems: [v], type: arrayOf(v.type), loc } : v;
    // SCR_FROM_STRINGS 1, SCR_FROM_SINGLE 2 (scr_runtime.h); the options
    // add SCR_FROM_BYTE_MODE 4 and SCR_FROM_HAS_HWM 8.
    const flags = ((single ?? elem) === "string" ? 1 : 0) | (single ? 2 : 0) | opts.flags;
    return {
      kind: "libCall",
      fn: "readable.fromArr",
      args: [arr, numLit(flags, loc), hwm],
      type,
      loc,
    };
  }
  const anySrc =
    srcT?.kind === "dyn" ||
    (srcT?.kind === "set" && typedElem(srcT.elem) !== null) ||
    (srcNode !== undefined &&
      srcT === null &&
      (lowerer.typeOf(srcNode).flags & ts.TypeFlags.Any) !== 0);
  if (js || anySrc) {
    // The checked-dynamic form: the runtime takes from.js's ladder
    // (ERR_INVALID_ARG_TYPE for a non-iterable, the options, null values).
    const src = srcNode ? lowerer.lowerExprExpecting(srcNode, DYN) : dynUndefinedExpr(loc);
    const o = lowerOperatorValue(lowerer, optsNode, "Readable.from options", loc, true);
    return { kind: "libCall", fn: "readable.fromDyn", args: [src, o], type, loc };
  }
  if (srcNode && (single || elem)) {
    lowerer.noLowering(
      "Readable.from with these options",
      optsNode!,
      "an object literal with 'objectMode' (true or false) and a number 'highWaterMark' is supported",
    );
  }
  lowerer.noLowering(
    `Readable.from over a '${srcT ? lowerer.fmt(srcT) : "?"}' source`,
    srcNode ?? call,
    "the supported sources are a string or Buffer, and arrays, Sets, generators and class iterables of strings or Buffers",
  );
}

/** Whether a generator's yields are stream chunks: strings, Buffers, a
 * union of them (null included: the runtime destroys the stream with
 * ERR_STREAM_NULL_VALUES), or checked-dynamic values (checked when
 * pushed). */
function fromGenChunk(lowerer: Lowerer, t: IrType): boolean {
  const chunk = (a: IrType): boolean =>
    a.kind === "string" || (a.kind === "bytes" && a.elem === "u8") || a.kind === "nullT";
  if (t.kind === "dyn" || (chunk(t) && t.kind !== "nullT")) return true;
  if (t.kind !== "union") return false;
  return lowerer.unions.get(t.unionId)?.arms.every(chunk) ?? false;
}

/** The helpers Readable.from pulls a compiled generator through, as
 * closures in libcall order: a sync generator's next/return/throw answer
 * the next value as a checked-dynamic value or the done marker
 * (readable.fromDone); an async generator's next/return/throw answer the
 * resume's promise, followed by `read`, which maps its IteratorResult the
 * same way. Interned per generator type. Null when the result record has
 * no lowering. */
function fromGenHelpers(
  lowerer: Lowerer,
  gen: IrType & { kind: "generator" },
  loc: SrcLoc,
): IrExpr[] | null {
  const recT = genResultRecord(gen.yieldT, gen.retT, lowerer.shapes, lowerer.unions);
  const valueT =
    recT && lowerer.shapes.get(recT.shapeId)?.fields.find((f) => f.name === "value")?.type;
  if (!recT || !valueT) return null;
  const done = (): IrExpr => ({
    kind: "libCall",
    fn: "readable.fromDone",
    args: [],
    type: DYN,
    loc,
  });
  // `r.done ? done : r.value` over a record local.
  const readRecord = (localId: string): IrStmt[] | null => {
    const r = varRef(localId, recT, loc);
    const value = extractIteratorValue(
      lowerer,
      gen.yieldT,
      valueT,
      { kind: "recordGet", obj: r, shapeId: recT.shapeId, field: "value", type: valueT, loc },
      loc,
    );
    if (!value) return null;
    return [
      {
        kind: "if",
        cond: { kind: "recordGet", obj: r, shapeId: recT.shapeId, field: "done", type: BOOL, loc },
        then: [{ kind: "return", value: done(), loc }],
        else_: null,
        loc,
      },
      { kind: "return", value: lowerer.coerceToExpected(value, DYN), loc },
    ];
  };
  const promiseT: IrType = { kind: "promise", inner: recT };
  const define = (
    role: string,
    params: { id: string; type: IrType }[],
    returnType: IrType,
    body: IrStmt[],
    locals: { id: string; type: IrType }[] = [],
  ): IrExpr => {
    const key = `streamFromGen:${role}:${typeKey(gen)}`;
    let name = lowerer.valueHelpers.get(key);
    if (!name) {
      name = keyedHelperName(lowerer, `%stream.fromGen.${role}`, key);
      lowerer.valueHelpers.set(key, name);
      lowerer.liftedFns.push({
        name,
        params: params.map((p) => ({ localId: p.id, name: p.id.split(".")[0]!, type: p.type })),
        returnType,
        locals: [...params, ...locals].map((l) => ({
          id: l.id,
          name: l.id.split(".")[0]!,
          type: l.type,
          mutable: false,
        })),
        body,
        loc,
      });
    }
    return {
      kind: "closure",
      fnName: name,
      captures: [],
      type: funcOf(
        params.map((p) => p.type),
        returnType,
      ),
      loc,
    };
  };
  const g = { id: "gen.0", type: gen as IrType };
  const e = { id: "err.0", type: DYN };
  const r = { id: "res.0", type: recT as IrType };
  const genRef = varRef("gen.0", gen, loc) as IrExpr & { type: typeof gen };
  const resume = (mode: "next" | "return" | "throw"): IrExpr => ({
    kind: "genResume",
    mode,
    gen: genRef,
    arg: mode === "throw" ? varRef("err.0", DYN, loc) : null,
    type: gen.async ? promiseT : recT,
    loc,
  });
  const read = readRecord("res.0");
  if (!read) return null;
  if (gen.async) {
    const ret = (mode: "next" | "return" | "throw"): IrStmt[] => [
      { kind: "return", value: resume(mode), loc },
    ];
    return [
      define("anext", [g], promiseT, ret("next")),
      define("aread", [r], DYN, read),
      define("areturn", [g], promiseT, ret("return")),
      define("athrow", [g, e], promiseT, ret("throw")),
    ];
  }
  const viaRecord = (mode: "next" | "return" | "throw"): IrStmt[] => [
    { kind: "varDecl", localId: "res.0", init: resume(mode), loc },
    ...read,
  ];
  const next: IrStmt[] = stepDrivable(gen)
    ? [
        {
          kind: "if",
          cond: genStep(genRef, loc),
          then: [{ kind: "return", value: done(), loc }],
          else_: null,
          loc,
        },
        { kind: "return", value: lowerer.coerceToExpected(genValue(genRef, loc), DYN), loc },
      ]
    : viaRecord("next");
  const withRecord = stepDrivable(gen) ? [] : [r];
  return [
    define("next", [g], DYN, next, withRecord),
    define("return", [g], DYN, viaRecord("return"), [r]),
    define("throw", [g, e], DYN, viaRecord("throw"), [r]),
  ];
}

/** `{ next() { const r = it.next(); return { value: r.value, done: r.done }; } }`
 * over a class iterator `it`, as a checked-dynamic object: an interned
 * lifted function per iterator class takes the iterator and answers the
 * object, whose `next` closure captures it. */
function classIteratorObject(
  lowerer: Lowerer,
  cit: ClassIteratorInfo,
  iter: IrExpr,
  loc: SrcLoc,
): IrExpr {
  const key = `streamFromIter:${cit.iterT.className}`;
  let name = lowerer.valueHelpers.get(key);
  if (!name) {
    name = keyedHelperName(lowerer, "%stream.fromIter", key);
    lowerer.valueHelpers.set(key, name);
    const nextName = `${name}.next`;
    const nextT = funcOf([], DYN);
    const it: IrLocal = { id: "it.0", name: "it", type: cit.iterT, mutable: false, boxed: true };
    const r: IrLocal = { id: "res.0", name: "res", type: cit.resultT, mutable: false };
    const field = (f: string, t: IrType): IrExpr => ({
      kind: "recordGet",
      obj: varRef(r.id, cit.resultT, loc),
      shapeId: cit.resultT.shapeId,
      field: f,
      type: t,
      loc,
    });
    const str = (value: string): IrExpr => ({ kind: "strLit", value, type: STRING, loc });
    lowerer.liftedFns.push({
      name: nextName,
      params: [],
      returnType: DYN,
      captures: [{ localId: it.id, name: it.name, type: it.type }],
      locals: [it, r],
      body: [
        {
          kind: "varDecl",
          localId: r.id,
          init: classIteratorNextCall(lowerer, cit, varRef(it.id, cit.iterT, loc), loc),
          loc,
        },
        {
          kind: "return",
          value: {
            kind: "dynObjLit",
            fields: [
              {
                key: str("value"),
                value: lowerer.coerceToExpected(field("value", cit.valueT), DYN),
              },
              {
                key: str("done"),
                value: {
                  kind: "dynFrom",
                  value: cit.hasDone ? field("done", BOOL) : boolLit(false, loc),
                  type: DYN,
                  loc,
                },
              },
            ],
            type: DYN,
            loc,
          },
          loc,
        },
      ],
      loc,
    });
    lowerer.liftedFns.push({
      name,
      params: [{ localId: it.id, name: it.name, type: it.type }],
      returnType: DYN,
      locals: [it],
      body: [
        {
          kind: "return",
          value: {
            kind: "dynObjLit",
            fields: [
              {
                key: str("next"),
                value: {
                  kind: "dynFrom",
                  value: { kind: "closure", fnName: nextName, captures: [it.id], type: nextT, loc },
                  type: DYN,
                  loc,
                },
              },
            ],
            type: DYN,
            loc,
          },
          loc,
        },
      ],
      loc,
    });
  }
  return { kind: "call", callee: name, args: [iter], type: DYN, loc };
}

/** A class's zero-parameter `[Symbol.asyncIterator]()` (checked first, as
 * from.js does) or `[Symbol.iterator]()` method that returns a generator,
 * with its method slot. */
function classGeneratorMethodOf(
  lowerer: Lowerer,
  t: IrType & { kind: "object" },
): { method: string; gen: IrType & { kind: "generator" } } | null {
  const info = lowerer.classes.get(t.className);
  if (!info) return null;
  for (const method of ["sym:asyncIterator", "sym:iterator"]) {
    const m = lowerer.findMethodOn(info, method);
    if (!m) continue;
    const ret = m.sig.ret;
    if (m.sig.abstract === true || m.sig.params.length !== 0 || ret.kind !== "generator")
      return null;
    return { method, gen: ret };
  }
  return null;
}

/** An async class iterable's protocol, statically resolved: the receiver's
 * zero-parameter `[Symbol.asyncIterator]()` returns a class whose
 * `next()` returns a promise of a `{ value, done? }` record, and whose
 * optional `return()` does the same. */
interface ClassAsyncIteratorInfo {
  className: string;
  iterT: IrType & { kind: "object" };
  resultT: IrType & { kind: "record" };
  valueT: IrType;
  hasReturn: boolean;
}

function classAsyncIteratorOf(
  lowerer: Lowerer,
  t: IrType & { kind: "object" },
): ClassAsyncIteratorInfo | null {
  const info = lowerer.classes.get(t.className);
  const open = info ? lowerer.findMethodOn(info, "sym:asyncIterator") : null;
  if (!open || open.sig.abstract === true || open.sig.params.length !== 0) return null;
  const iterT = open.sig.ret;
  if (iterT.kind !== "object") return null;
  const itInfo = lowerer.classes.get(iterT.className);
  if (!itInfo || lowerer.findMethodOn(itInfo, "throw")) return null;
  const record = (name: string): (IrType & { kind: "record" }) | null => {
    const m = lowerer.findMethodOn(itInfo, name);
    if (!m || m.sig.abstract === true || m.sig.params.length !== 0) return null;
    const ret = m.sig.ret;
    return ret.kind === "promise" && ret.inner.kind === "record" ? ret.inner : null;
  };
  const resultT = record("next");
  if (!resultT) return null;
  const shape = lowerer.shapes.get(resultT.shapeId);
  const value = shape?.fields.find((f) => f.name === "value");
  const done = shape?.fields.find((f) => f.name === "done");
  if (!value || (done && done.type.kind !== "bool")) return null;
  const hasReturn = lowerer.findMethodOn(itInfo, "return") !== null;
  if (hasReturn && !record("return")) return null;
  return { className: t.className, iterT, resultT, valueT: value.type, hasReturn };
}

/** The checked-dynamic iterator object over an async class iterable:
 * `recv[Symbol.asyncIterator]()` runs when the stream is built, and the
 * object's `next` (and `return`, when the class declares one) answer the
 * iterator's own promises boxed. */
function classAsyncIteratorObject(
  lowerer: Lowerer,
  cit: ClassAsyncIteratorInfo,
  recv: IrExpr,
  loc: SrcLoc,
): IrExpr {
  const key = `streamFromAsyncIter:${cit.className}`;
  let name = lowerer.valueHelpers.get(key);
  if (!name) {
    name = keyedHelperName(lowerer, "%stream.fromAsyncIter", key);
    lowerer.valueHelpers.set(key, name);
    const it: IrLocal = { id: "it.0", name: "it", type: cit.iterT, mutable: false, boxed: true };
    const src: IrLocal = {
      id: "src.0",
      name: "src",
      type: { kind: "object", className: cit.className },
      mutable: false,
    };
    const str = (value: string): IrExpr => ({ kind: "strLit", value, type: STRING, loc });
    const method = (m: string): { key: IrExpr; value: IrExpr } => {
      const fnName = `${name}.${m}`;
      const call = accessorCall(
        lowerer,
        cit.iterT.className,
        m,
        varRef(it.id, cit.iterT, loc),
        [],
        { kind: "promise", inner: cit.resultT },
        loc,
      );
      lowerer.liftedFns.push({
        name: fnName,
        params: [],
        returnType: DYN,
        captures: [{ localId: it.id, name: it.name, type: it.type }],
        locals: [it],
        body: [{ kind: "return", value: { kind: "dynFrom", value: call, type: DYN, loc }, loc }],
        loc,
      });
      return {
        key: str(m),
        value: {
          kind: "dynFrom",
          value: { kind: "closure", fnName, captures: [it.id], type: funcOf([], DYN), loc },
          type: DYN,
          loc,
        },
      };
    };
    const fields = [method("next"), ...(cit.hasReturn ? [method("return")] : [])];
    lowerer.liftedFns.push({
      name,
      params: [{ localId: src.id, name: src.name, type: src.type }],
      returnType: DYN,
      locals: [src, it],
      body: [
        {
          kind: "varDecl",
          localId: it.id,
          init: accessorCall(
            lowerer,
            cit.className,
            "sym:asyncIterator",
            varRef(src.id, src.type, loc),
            [],
            cit.iterT,
            loc,
          ),
          loc,
        },
        { kind: "return", value: { kind: "dynObjLit", fields, type: DYN, loc }, loc },
      ],
      loc,
    });
  }
  return { kind: "call", callee: name, args: [recv], type: DYN, loc };
}

/** Readable.from's typed options: an object literal of `objectMode`
 * (a boolean literal) and `highWaterMark` (a number), as SCR_FROM_* flag
 * bits and the hwm expression; null for any other shape. */
function fromOptions(
  lowerer: Lowerer,
  node: ts.Expression,
): { flags: number; hwm: ts.Expression | null } | null {
  if (!ts.isObjectLiteralExpression(node)) return null;
  let flags = 0;
  let hwm: ts.Expression | null = null;
  for (const prop of node.properties.nodes) {
    if (
      !ts.isPropertyAssignment(prop) ||
      !(ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name))
    ) {
      return null;
    }
    const value = prop.initializer;
    if (prop.name.text === "objectMode") {
      if (value.kind === ts.SyntaxKind.FalseKeyword) flags |= 4;
      else if (value.kind === ts.SyntaxKind.TrueKeyword) flags &= ~4;
      else return null;
    } else if (prop.name.text === "highWaterMark") {
      if (lowerer.mapTypeOf(lowerer.typeOf(value))?.kind !== "f64") return null;
      flags |= 8;
      hwm = value;
    } else {
      return null;
    }
  }
  return { flags, hwm };
}

/** `const Writable = stream.Writable` — a runtime stream CLASS bound
 * through a namespace member: alias plumbing with no storage (both
 * declaration walks skip it; uses resolve through builtinStreamInfoOf's
 * alias following). Only the five stream class names count — value
 * members (stream.getDefaultHighWaterMark as a value, ...) keep their
 * per-site fences. */
export function streamClassAliasDecl(
  lowerer: Lowerer,
  nameNode: ts.Node,
  init: ts.Expression | undefined,
): boolean {
  if (!ts.isIdentifier(nameNode) || !init) return false;
  if (!ts.isPropertyAccessExpression(init) || init.questionDotToken) return false;
  let isStreamClass = false;
  for (const [, rec] of RUNTIME_STREAM_CLASSES) {
    if (rec.lib === init.name.text) isStreamClass = true;
  }
  if (!isStreamClass) return false;
  return lowerer.builtinNamespaceModuleOf(init.expression) === "stream";
}

/* ── the module functions (finished / pipeline — the callback forms) ──── */

/** Node's pipeline stage ladder text (lib/internal/streams/pipeline.js's
 * makeAsyncIterable — every stage position renders the same "body"
 * clause). finished() keeps its narrower isNodeStream wording. */
const PIPELINE_STAGE_EXPECTED =
  "of type function or an instance of Blob, ReadableStream, WritableStream, Stream, Iterable, AsyncIterable, or Promise or { readable, writable } pair";

/** A stream-rooted argument, lowered — or the pointed fence (pipeline's
 * iterable/generator/function stages have no lowering yet). `what` picks
 * the validation ladder: finished() rejects EVERY non-stream through
 * isNodeStream, while pipeline() accepts iterables (strings, arrays) and
 * { readable, writable } pairs — those shapes fence instead of throwing
 * a ladder Node never throws. */
function lowerStreamArg(
  lowerer: Lowerer,
  node: ts.Expression,
  what: "finished" | "pipeline" | "addAbortSignal" | "compose",
): IrExpr {
  const lowered = lowerer.lowerExpr(node);
  // A Hash, Hmac, Cipheriv or Decipheriv stage is its Transform; pipeline
  // and compose stages keep the value alive until the stream settles.
  const v = isValueStream(lowerer, node)
    ? valueStreamOf(lowered, what === "pipeline" || what === "compose")
    : lowered;
  // A checked-dynamic pipeline stage (an untyped source or destination):
  // a boxed native stream unwraps at run time; other values (iterables,
  // functions) throw the not-supported Error there.
  if (v.type.kind === "dyn" && what === "pipeline") {
    noteUntypedStreamFlow(lowerer, null);
    return {
      kind: "libCall",
      fn: "stream.unboxDyn",
      args: [
        v,
        strLit(
          lowerer.dynNodeStreams
            ? "pipeline stages other than native streams (JavaScript stream objects, iterables, generators, plain functions, and { readable, writable } pairs) are not supported yet"
            : "pipeline stages other than native streams (iterables, generators, plain functions, and { readable, writable } pairs) are not supported yet",
          locOf(node),
        ),
      ],
      type: { kind: "object", className: "%Duplex" },
      loc: locOf(node),
    };
  }
  const info = v.type.kind === "object" ? lowerer.classes.get(v.type.className) : undefined;
  if (!streamSidesOf(lowerer, info)) {
    // A provably-non-stream value in a JS source (the invalid-input
    // probes: finished({}, cb), pipeline(42, dst, cb)): Node's gate
    // throws ERR_INVALID_ARG_TYPE before any watcher exists.
    const argTypeThrow = (argName: string, expected: string): never => {
      throw new StreamArgTypeThrow({
        kind: "libCall",
        fn: "error.argTypeThrow",
        args: [
          { kind: "strLit", value: argName, type: STRING, loc: locOf(node) },
          { kind: "strLit", value: expected, type: STRING, loc: locOf(node) },
          { kind: "dynFrom", value: v, type: DYN, loc: locOf(node) },
        ],
        type: VOID,
        loc: locOf(node),
      });
    };
    if (isJsSourceFile(ts.getSourceFileOfNode(node)) && lowerer.dynConvertible(v.type)) {
      if (what === "pipeline") {
        // Strings and arrays are iterables — VALID pipeline stages in
        // Node — and a record carrying a readable/writable member may be
        // the duplex-pair form; none of those shapes has a lowering, so
        // they take the pointed fence below, never a throw.
        const pairish =
          v.type.kind === "record" &&
          (lowerer.shapes.get(v.type.shapeId)?.fields ?? []).some(
            (f) => f.name === "readable" || f.name === "writable",
          );
        if (
          (v.type.kind === "record" && !pairish) ||
          v.type.kind === "f64" ||
          v.type.kind === "bool" ||
          v.type.kind === "nullT"
        ) {
          argTypeThrow("body", PIPELINE_STAGE_EXPECTED);
        }
      } else if (
        (ts.isObjectLiteralExpression(node) && node.properties.nodes.length === 0) ||
        v.type.kind === "record" ||
        v.type.kind === "string" ||
        v.type.kind === "f64" ||
        v.type.kind === "bool" ||
        v.type.kind === "array" ||
        v.type.kind === "nullT"
      ) {
        argTypeThrow("stream", "an instance of ReadableStream, WritableStream, or Stream");
      }
    }
    lowerer.noLowering(
      `${what} over a '${lowerer.fmt(v.type)}'`,
      node,
      what === "pipeline" || what === "compose"
        ? "stream stages are the lowered surface — Node also accepts iterables (strings, arrays), generators, plain functions, and { readable, writable } pairs, but those have no lowering yet"
        : "stream arguments are the lowered surface (iterables, generators, and plain functions have no lowering yet)",
    );
  }
  return v;
}

/** The always-throw replacement lowerStreamArg surfaces when the stream
 * slot holds a provably-non-stream value — the CALL's lowering catches it
 * and answers the throw as the whole call's value (Node throws before
 * registering anything, so the other arguments never evaluate their
 * effects; listener arguments are effect-free in practice). */
class StreamArgTypeThrow extends Error {
  constructor(readonly expr: IrExpr) {
    super("stream argument is not a stream");
  }
}

/** The finished/pipeline completion callback: an inline function lowers
 * through the option-callback machinery (leading `this`, an `Error |
 * null` prefix — Node binds the stream and passes the error); any other
 * value adapts through the checked-dynamic boundary (mustCall wrappers —
 * the runtime inv calls it with NO arguments on success, Node's eos
 * convention). */
function lowerEosCallback(
  lowerer: Lowerer,
  which: string,
  node: ts.Expression,
  thisType: IrType,
): { cb: IrExpr; dyn: boolean } {
  if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
    // The error parameter takes what the user declared when it is an
    // Error/null/undefined union (@types spells `ErrnoException | null |
    // undefined`); the emitted thunk picks the undefined arm on success.
    let tuple: IrType[] = [errorOrNull(lowerer)];
    try {
      const { funcType } = lowerer.lambdaSignature(node);
      const p0 = funcType.params[0];
      if (p0?.kind === "union") {
        const def = lowerer.unions.get(p0.unionId);
        if (
          def &&
          def.arms.some((a) => a.kind === "object" && a.className === "%Error") &&
          def.arms.every(
            (a) =>
              a.kind === "nullT" ||
              a.kind === "undefinedT" ||
              (a.kind === "object" && a.className === "%Error"),
          )
        ) {
          tuple = [p0];
        }
      }
    } catch {
      /* the fixed tuple speaks */
    }
    return { cb: lowerStreamCallback(lowerer, which, node, thisType, tuple), dyn: false };
  }
  const getRecord = (id: string) => lowerer.shapes.get(id);
  const getUnion = (id: string) => lowerer.unions.get(id);
  let t: IrType | null;
  try {
    const ct = lowerer.typeOf(node);
    t = lowerer.mapTypeOf(ct) ?? dynFallbackType(lowerer, node, ct);
  } catch {
    t = null;
  }
  if (t?.kind === "dyn") {
    const v = lowerer.lowerExpr(node);
    if (v.type.kind === "dyn") return { cb: v, dyn: true };
  } else if (t?.kind === "func") {
    const cb = lowerer.lowerExpr(node);
    if (cb.type.kind === "dyn") return { cb, dyn: true };
    if (cb.type.kind === "func" && canBoxFuncIntoDyn(cb.type, getRecord, getUnion)) {
      return { cb: { kind: "dynFrom", value: cb, type: DYN, loc: locOf(node) }, dyn: true };
    }
  }
  lowerer.noLowering(
    `${which} with this callback value`,
    node,
    "write the callback inline, or pass a function value that crosses the checked-dynamic boundary",
  );
}

/** finished()'s options literal: readable/writable/error (and cleanup
 * for the promise form) as boolean literals, signal as any expression.
 * readable/writable answer -1 when absent (Node's default: whether the
 * stream has that side). */
function eosOptions(
  lowerer: Lowerer,
  node: ts.Expression,
  promiseForm: boolean,
): { readable: number; writable: number; error: boolean; cleanup: boolean; signal: IrExpr | null } {
  const out = {
    readable: -1,
    writable: -1,
    error: true,
    cleanup: false,
    signal: null as IrExpr | null,
  };
  if (!ts.isObjectLiteralExpression(node)) {
    lowerer.noLowering(
      "finished options that are not an object literal",
      node,
      "write the options inline: finished(stream, { readable, writable, error, signal })",
    );
  }
  const literal = (p: ts.PropertyAssignment, key: string): boolean => {
    if (p.initializer.kind === ts.SyntaxKind.TrueKeyword) return true;
    if (p.initializer.kind === ts.SyntaxKind.FalseKeyword) return false;
    lowerer.noLowering(
      `the finished option '${key}' with a non-literal value`,
      p.initializer,
      "pass true or false",
    );
  };
  for (const p of node.properties.nodes) {
    const key =
      (ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p)) && ts.isIdentifier(p.name)
        ? p.name.text
        : null;
    if (key === "signal") {
      out.signal = ts.isShorthandPropertyAssignment(p)
        ? lowerer.lowerExprExpecting(p.name as ts.Identifier, DYN)
        : lowerer.lowerExprExpecting((p as ts.PropertyAssignment).initializer, DYN);
      continue;
    }
    if (key !== null && ts.isPropertyAssignment(p)) {
      if (key === "readable") out.readable = literal(p, key) ? 1 : 0;
      else if (key === "writable") out.writable = literal(p, key) ? 1 : 0;
      else if (key === "error") out.error = literal(p, key);
      else if (key === "cleanup" && promiseForm) out.cleanup = literal(p, key);
      else {
        lowerer.noLowering(
          `the finished option '${key}'`,
          p,
          promiseForm
            ? "readable, writable, error, cleanup and signal are the supported options"
            : "readable, writable, error and signal are the supported options",
        );
      }
      continue;
    }
    lowerer.noLowering(
      "finished options with this member",
      p,
      "write each option as a plain property",
    );
  }
  return out;
}

/** pipeline()'s trailing options literal (the promise form): signal as
 * any expression, end as a boolean literal. */
function pipelineOptions(
  lowerer: Lowerer,
  node: ts.ObjectLiteralExpression,
): { end: boolean; signal: IrExpr | null } {
  const out = { end: true, signal: null as IrExpr | null };
  for (const p of node.properties.nodes) {
    const key =
      (ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p)) && ts.isIdentifier(p.name)
        ? p.name.text
        : null;
    if (key === "signal") {
      out.signal = ts.isShorthandPropertyAssignment(p)
        ? lowerer.lowerExprExpecting(p.name as ts.Identifier, DYN)
        : lowerer.lowerExprExpecting((p as ts.PropertyAssignment).initializer, DYN);
      continue;
    }
    if (key === "end" && ts.isPropertyAssignment(p)) {
      if (p.initializer.kind === ts.SyntaxKind.TrueKeyword) continue;
      if (p.initializer.kind === ts.SyntaxKind.FalseKeyword) {
        out.end = false;
        continue;
      }
      lowerer.noLowering(
        "the pipeline option 'end' with a non-literal value",
        p.initializer,
        "pass true or false",
      );
    }
    lowerer.noLowering(
      key === null ? "pipeline options with this member" : `the pipeline option '${key}'`,
      p,
      "signal and end are the supported pipeline options",
    );
  }
  return out;
}

/** `finished(...)` / `pipeline(...)` / `getDefaultHighWaterMark(...)`
 * imported from node:stream (named imports, destructured requires, and
 * namespace-member calls all land here). Null for members this spoke
 * does not own — the caller's module-qualified fence speaks. */
export function lowerStreamModuleCall(
  lowerer: Lowerer,
  call: ts.CallExpression,
  bi: { module: string; member: string },
  loc: SrcLoc,
): IrExpr | null {
  if (bi.module === "stream/promises") {
    const args = call.arguments.nodes;
    // finished(stream) → a pending void promise the terminal watcher
    // settles (rejected with the stream's error, or
    // ERR_STREAM_PREMATURE_CLOSE — the callback form's status, boxed
    // through the promise instead). The options argument has no lowering.
    if (bi.member === "finished") {
      if (args.length !== 1 && args.length !== 2) {
        lowerer.noLowering(
          `stream/promises.finished with ${args.length} arguments`,
          call,
          "the supported forms are finished(stream) and finished(stream, options)",
        );
      }
      let recv: IrExpr;
      try {
        recv = lowerStreamArg(lowerer, args[0]!, "finished");
      } catch (e) {
        if (e instanceof StreamArgTypeThrow) return e.expr;
        throw e;
      }
      const optsNode = args[1];
      if (optsNode !== undefined && optsNode.kind !== ts.SyntaxKind.NullKeyword) {
        const o = eosOptions(lowerer, optsNode, true);
        const head: IrExpr[] = [
          recv,
          numLit(o.readable, loc),
          numLit(o.writable, loc),
          boolLit(o.error, loc),
          boolLit(o.cleanup, loc),
        ];
        return {
          kind: "libCall",
          fn: o.signal ? "sp.finishedOptsSignal" : "sp.finishedOpts",
          args: o.signal ? [...head, o.signal] : head,
          type: { kind: "promise", inner: VOID },
          loc,
        };
      }
      return {
        kind: "libCall",
        fn: "sp.finished",
        args: [recv],
        type: { kind: "promise", inner: VOID },
        loc,
      };
    }
    // pipeline(...streams) → the callback pipeline's chaining/destroyer
    // semantics with the settlement on a promise. Stream stages only
    // (lowerStreamArg's fence); Node's promise resolves undefined for
    // stream destinations, so the result is a void promise.
    if (bi.member === "pipeline") {
      if (args.length < 2) {
        lowerer.noLowering(
          `stream/promises.pipeline with ${args.length} arguments`,
          call,
          "the supported form is pipeline(source, ...streams)",
        );
      }
      const lastArg = args[args.length - 1]!;
      const opts =
        ts.isObjectLiteralExpression(lastArg) && args.length >= 3
          ? pipelineOptions(lowerer, lastArg)
          : null;
      const stageArgs = opts ? args.slice(0, -1) : args;
      if (hasPipelineFunctionStage(lowerer, stageArgs)) {
        if (opts) {
          lowerer.noLowering(
            "pipeline with function stages or iterable sources and options",
            lastArg,
            "pipeline(source, async function* (source) { ... }, destination) without options is supported",
          );
        }
        const staged = lowerPipelineStages(lowerer, stageArgs, loc);
        // A promise destination's value settles the result (same type).
        return staged.wrap({
          kind: "libCall",
          fn: "sp.pipelineStages",
          args: staged.args,
          type: staged.destPromise ?? { kind: "promise", inner: VOID },
          loc,
        });
      }
      let streams: IrExpr[];
      try {
        streams = stageArgs.map((a) => lowerStreamArg(lowerer, a, "pipeline"));
      } catch (e) {
        if (e instanceof StreamArgTypeThrow) return e.expr;
        throw e;
      }
      if (opts) {
        const head = [numLit(streams.length, loc), ...streams, boolLit(opts.end, loc)];
        return {
          kind: "libCall",
          fn: opts.signal ? "sp.pipelineOptsSignal" : "sp.pipelineOpts",
          args: opts.signal ? [...head, opts.signal] : head,
          type: { kind: "promise", inner: VOID },
          loc,
        };
      }
      return {
        kind: "libCall",
        fn: "sp.pipeline",
        args: [numLit(streams.length, loc), ...streams],
        type: { kind: "promise", inner: VOID },
        loc,
      };
    }
    return null;
  }
  if (bi.module === "stream/consumers") {
    const args = call.arguments.nodes;
    // text/json/buffer/arrayBuffer(stream) → a pending promise the
    // accumulate-and-settle machinery resolves at the terminal point (the
    // utf8 decode / the parsed JSON dyn tree / the concatenated bytes / an
    // ArrayBuffer dyn over them) or rejects — with the stream's error,
    // ERR_STREAM_PREMATURE_CLOSE on an early close, or json's SyntaxError
    // on malformed text, Node's own rejection set. blob returns null here,
    // so the module-qualified fence (with the pointed hint in
    // BUILTIN_MODULE_FENCE_HINTS) speaks.
    if (
      bi.member === "text" ||
      bi.member === "json" ||
      bi.member === "buffer" ||
      bi.member === "arrayBuffer"
    ) {
      if (args.length !== 1) {
        lowerer.noLowering(
          `stream/consumers.${bi.member} with ${args.length} arguments`,
          call,
          `the supported form is ${bi.member}(stream)`,
        );
      }
      // A provably-non-stream argument: Node's consumers reject the
      // returned promise asynchronously with the plain "stream is not
      // async iterable" TypeError — no sync ladder exists to borrow
      // (finished/pipeline throw synchronously; consumers do not). A
      // sync throw here would be observably wrong timing, so the
      // provable case takes the named fence instead.
      // A Hash, Hmac, Cipheriv or Decipheriv is read through its Transform.
      const argV = isValueStream(lowerer, args[0]!)
        ? valueStreamOf(lowerer.lowerExpr(args[0]!))
        : lowerer.lowerExpr(args[0]!);
      const argInfo =
        argV.type.kind === "object" ? lowerer.classes.get(argV.type.className) : undefined;
      if (argV.type.kind !== "dyn" && !streamSidesOf(lowerer, argInfo)) {
        lowerer.noLowering(
          `stream/consumers.${bi.member} over a value that is not a stream`,
          call,
          "Node rejects the promise with 'stream is not async iterable' — pass a readable stream",
        );
      }
      const recv: IrExpr = argV;
      const inner: IrType = bi.member === "text" ? STRING : bi.member === "buffer" ? BYTES : DYN;
      return {
        kind: "libCall",
        fn: `sc.${bi.member}` as IrLibFn,
        args: [recv],
        type: { kind: "promise", inner },
        loc,
      };
    }
    return null;
  }
  if (bi.module !== "stream") return null;
  const args = call.arguments.nodes;

  if (bi.member === "getDefaultHighWaterMark") {
    // Node 24: 65536 bytes / 16 objects — compile-time literals only.
    // The byte default is platform-split at Node's source
    // (lib/internal/streams/state.js: win32 keeps 16 KiB), so the fold
    // follows the TARGET platform like the path-module binding.
    if (args.length === 1 && args[0]!.kind === ts.SyntaxKind.FalseKeyword) {
      return numLit(lowerer.targetPlatform === "win32" ? 16384 : 65536, loc);
    }
    if (args.length === 1 && args[0]!.kind === ts.SyntaxKind.TrueKeyword) return numLit(16, loc);
    lowerer.noLowering(
      "getDefaultHighWaterMark with a non-literal argument",
      call,
      "the objectMode flag must be a compile-time boolean",
    );
  }

  if (bi.member === "addAbortSignal") {
    // addAbortSignal(signal, stream) → the stream: destroyed with an
    // AbortError when the signal aborts (now, if it already has).
    if (args.length !== 2) {
      lowerer.noLowering(
        `addAbortSignal with ${args.length} arguments`,
        call,
        "the supported form is addAbortSignal(signal, stream)",
      );
    }
    const signal = lowerer.lowerExprExpecting(args[0]!, DYN);
    let stream: IrExpr;
    try {
      stream = lowerStreamArg(lowerer, args[1]!, "addAbortSignal");
    } catch (e) {
      if (e instanceof StreamArgTypeThrow) return e.expr;
      throw e;
    }
    return {
      kind: "libCall",
      fn: "stream.addAbortSignalFn",
      args: [signal, stream],
      type: stream.type,
      loc,
    };
  }

  if (bi.member === "finished") {
    if (args.length !== 2 && args.length !== 3) {
      lowerer.noLowering(
        `finished with ${args.length} arguments`,
        call,
        "the supported forms are finished(stream, callback) and finished(stream, options, callback)",
      );
    }
    let recv: IrExpr;
    try {
      recv = lowerStreamArg(lowerer, args[0]!, "finished");
    } catch (e) {
      if (e instanceof StreamArgTypeThrow) return e.expr;
      throw e;
    }
    if (args.length === 3 && args[1]!.kind !== ts.SyntaxKind.NullKeyword) {
      const o = eosOptions(lowerer, args[1]!, false);
      const { cb } = lowerEosCallback(lowerer, "finished", args[2]!, recv.type);
      const head: IrExpr[] = [
        recv,
        numLit(o.readable, loc),
        numLit(o.writable, loc),
        boolLit(o.error, loc),
      ];
      return {
        kind: "libCall",
        fn: o.signal ? "stream.finishedOptsSignal" : "stream.finishedOpts",
        args: o.signal ? [...head, o.signal, cb] : [...head, cb],
        type: funcOf([], VOID),
        loc,
      };
    }
    const { cb, dyn } = lowerEosCallback(lowerer, "finished", args[args.length - 1]!, recv.type);
    return {
      kind: "libCall",
      fn: dyn ? "stream.finishedDyn" : "stream.finished",
      args: [recv, cb],
      type: funcOf([], VOID),
      loc,
    };
  }

  if (bi.member === "pipeline") {
    if (args.length < 3) {
      lowerer.noLowering(
        `pipeline with ${args.length} arguments`,
        call,
        "the supported form is pipeline(source, ...streams, callback)",
      );
    }
    if (hasPipelineFunctionStage(lowerer, args.slice(0, -1))) {
      const staged = lowerPipelineStages(lowerer, args.slice(0, -1), loc);
      if (staged.dest !== 0) {
        // callback(err, value): the destination's value reaches the
        // callback through the checked-dynamic path. Node answers an
        // object-mode PassThrough here; reading it has no lowering.
        if (!ts.isExpressionStatement(call.parent)) {
          lowerer.noLowering(
            "using the PassThrough that pipeline() answers for a function destination",
            call,
            "read the destination's value in the callback",
          );
        }
        const cb = lowerer.lowerExprExpecting(args[args.length - 1]!, DYN);
        return staged.wrap({
          kind: "libCall",
          fn: "stream.pipelineStagesDyn",
          args: [...staged.args, cb],
          type: staged.last,
          loc,
        });
      }
      const { cb, dyn } = lowerEosCallback(
        lowerer,
        "pipeline",
        args[args.length - 1]!,
        staged.last,
      );
      return staged.wrap({
        kind: "libCall",
        fn: dyn ? "stream.pipelineStagesDyn" : "stream.pipelineStages",
        args: [...staged.args, cb],
        type: staged.last,
        loc,
      });
    }
    let streams: IrExpr[];
    try {
      streams = args.slice(0, -1).map((a) => lowerStreamArg(lowerer, a, "pipeline"));
    } catch (e) {
      if (e instanceof StreamArgTypeThrow) return e.expr;
      throw e;
    }
    const last = streams[streams.length - 1]!;
    const { cb, dyn } = lowerEosCallback(lowerer, "pipeline", args[args.length - 1]!, last.type);
    return {
      kind: "libCall",
      fn: dyn ? "stream.pipelineDyn" : "stream.pipeline",
      args: [numLit(streams.length, loc), ...streams, cb],
      type: last.type,
      loc,
    };
  }

  if (bi.member === "compose") return lowerStreamCompose(lowerer, call, loc);

  return null;
}

/** A pipeline() function stage: an inline function or arrow function, or
 * an identifier bound to a function declaration or to a `const`
 * initialized with one, which nothing reassigns. */
type StageFunction = ts.FunctionExpression | ts.ArrowFunction | ts.FunctionDeclaration;

/** The function a pipeline() argument writes or names, or null when the
 * argument is not a function stage. */
function pipelineStageFunction(lowerer: Lowerer, node: ts.Expression): StageFunction | null {
  if (ts.isFunctionExpression(node) || ts.isArrowFunction(node)) return node;
  if (!ts.isIdentifier(node)) return null;
  // The stage lowers the declaration's body again with its source typed
  // by the pipeline, so resolving it here must not report what collecting
  // the declaration's own signature deferred (resolveValueSymbol would).
  const resolve = (ident: ts.Identifier): ts.Symbol | undefined => {
    const found = lowerer.checker.getSymbolAtLocation(ident);
    return found && found.flags & ts.SymbolFlags.Alias
      ? lowerer.checker.getAliasedSymbol(found)
      : found;
  };
  const symbol = resolve(node);
  const declarations = symbol?.declarations ?? [];
  const bodies = declarations.filter((d) => !ts.isFunctionDeclaration(d) || d.body !== undefined);
  if (!symbol || bodies.length !== 1) return null;
  const decl = bodies[0]!;
  if (lowerer.isStdlibFile(ts.getSourceFileOfNode(decl))) return null;
  if (ts.isFunctionDeclaration(decl)) {
    return bindingNeverReassigned(lowerer, symbol, decl, resolve) ? decl : null;
  }
  if (
    ts.isVariableDeclaration(decl) &&
    decl.initializer &&
    ts.isVariableDeclarationList(decl.parent) &&
    (decl.parent.flags & ts.NodeFlags.Const) !== 0
  ) {
    let init: ts.Expression = decl.initializer;
    while (ts.isParenthesizedExpression(init)) init = init.expression;
    if (ts.isFunctionExpression(init) || ts.isArrowFunction(init)) return init;
  }
  return null;
}

function hasPipelineFunctionStage(lowerer: Lowerer, args: readonly ts.Expression[]): boolean {
  return (
    args.some((a) => pipelineStageFunction(lowerer, a) !== null) ||
    (args.length > 0 && iterableSourceType(lowerer, args[0]!) !== null)
  );
}

type SyncGenType = IrType & { kind: "generator" };

/** The element type of a pipeline source that is an iterable value (an
 * array, a string or a synchronous generator object), or null. */
function iterableSourceType(lowerer: Lowerer, node: ts.Expression): IrType | null {
  if (pipelineStageFunction(lowerer, node) !== null) return null;
  let t: IrType | null;
  try {
    t = lowerer.mapTypeOf(lowerer.typeOf(node));
  } catch {
    return null;
  }
  if (t?.kind === "array") return t.elem;
  if (t?.kind === "string") return STRING;
  if (t?.kind === "generator" && t.async !== true && stepDrivable(t)) return t.yieldT;
  return null;
}

/** A pipeline source that is an iterable value or a synchronous generator
 * function without parameters, as an async generator closure that steps
 * the value's iterator (or the generator the function returns) and yields
 * each element. Node's pipeline iterates such a source with `for await`,
 * through an async-from-sync iterator, and an async generator that
 * yields the same elements resumes its consumer on the same ticks. Null
 * when the source has no such lowering. */
function lowerIterableSource(
  lowerer: Lowerer,
  node: ts.Expression,
  fn: StageFunction | null,
  loc: SrcLoc,
): { closure: IrExpr; out: SyncGenType } | null {
  let value: IrExpr;
  if (fn !== null) {
    if (fn.parameters.nodes.length > 0) {
      lowerer.noLowering(
        "a synchronous generator function pipeline source with parameters",
        fn.parameters.nodes[0]!,
        "declare the source without parameters, or make it an async generator function",
      );
    }
    value = lowerer.lowerLambda(fn);
    if (value.type.kind !== "func" || value.type.ret.kind !== "generator") return null;
  } else {
    value = lowerer.lowerExpr(node);
  }
  const srcT = value.type;
  const elemT: IrType | null =
    srcT.kind === "func" && srcT.ret.kind === "generator"
      ? srcT.ret.yieldT
      : srcT.kind === "array"
        ? srcT.elem
        : srcT.kind === "string"
          ? STRING
          : srcT.kind === "generator" && srcT.async !== true
            ? srcT.yieldT
            : null;
  if (elemT === null) return null;
  const out: SyncGenType = {
    kind: "generator",
    async: true,
    yieldT: elemT,
    retT: VOID,
    nextT: UNDEFINED_T,
  };
  const resultType = genResultRecord(elemT, VOID, lowerer.shapes, lowerer.unions);
  if (!resultType) return null;
  const key = `pipelineSource:${typeKey(srcT)}`;
  let maker = lowerer.valueHelpers.get(key);
  if (!maker) {
    maker = `%stream.pipelineSource.${lowerer.valueHelpers.size}`;
    const genName = `${maker}.gen`;
    // The generator: g = the source's iterator; for (v of g) yield v.
    const frame = new LiftedFrame(loc);
    const srcId = frame.local("src", srcT, false);
    const src = varRef(srcId, srcT, loc);
    const syncT: SyncGenType = {
      kind: "generator",
      yieldT: elemT,
      retT: VOID,
      nextT: UNDEFINED_T,
    };
    let iterator: IrExpr | null;
    if (srcT.kind === "func") {
      iterator = { kind: "callValue", callee: src, args: [], type: srcT.ret, loc };
    } else if (srcT.kind === "array") {
      iterator = lowerArrayIteratorValue(lowerer, src, "values", syncT, loc);
    } else if (srcT.kind === "string") {
      iterator = lowerStringIteratorValue(lowerer, src, syncT, loc);
    } else {
      iterator = src;
    }
    if (iterator === null || iterator.type.kind !== "generator" || !stepDrivable(iterator.type))
      return null;
    const iterT = iterator.type;
    const gId = frame.local("g", iterT, false);
    const body: IrStmt[] = [
      { kind: "varDecl", localId: gId, init: iterator, loc },
      ...driveGenerator(
        lowerer,
        frame,
        gId,
        iterT,
        elemT,
        [],
        (v) => [{ kind: "exprStmt", expr: { kind: "yieldExpr", value: v, type: VOID, loc }, loc }],
        loc,
      ),
      { kind: "return", value: null, loc },
    ];
    const srcLocal = frame.locals.find((l) => l.id === srcId)!;
    srcLocal.boxed = true;
    lowerer.valueHelpers.set(key, maker);
    lowerer.liftedFns.push({
      name: genName,
      params: [],
      returnType: VOID,
      async: true,
      captures: [{ localId: srcId, name: "src", type: srcT }],
      locals: frame.locals,
      body,
      generator: { yieldT: elemT, nextT: UNDEFINED_T, resultType },
      loc,
    });
    // The maker: (src) => the generator function closed over src.
    const makerSrc: IrLocal = { id: "src.0", name: "src", type: srcT, mutable: false, boxed: true };
    lowerer.liftedFns.push({
      name: maker,
      params: [{ localId: makerSrc.id, name: makerSrc.name, type: srcT }],
      returnType: funcOf([], out),
      locals: [makerSrc],
      body: [
        {
          kind: "return",
          value: {
            kind: "closure",
            fnName: genName,
            captures: [makerSrc.id],
            type: funcOf([], out),
            loc,
          },
          loc,
        },
      ],
      loc,
    });
  }
  return {
    closure: { kind: "call", callee: maker, args: [value], type: funcOf([], out), loc },
    out,
  };
}

/** The lowered function stages of a pipeline: the libcall head [n, k,
 * positions, flags, mask, streams..., stages..., helpers..., box?,
 * (signal, abort)?], the destination's type (the last stream, or the
 * PassThrough a function destination answers), the destination kind
 * (SCR_PIPE_DEST_*), a promise destination's promise type, and a wrapper
 * that binds the pipeline's AbortController around the call when a
 * stage takes `{ signal }`. positions has bit j set when the pipeline's
 * j-th stage is a function; helpers holds (next, read, return) for each
 * generator pumped into a stream. */
interface PipelineStagesLowering {
  args: IrExpr[];
  last: IrType;
  dest: 0 | 2;
  destPromise: (IrType & { kind: "promise" }) | null;
  wrap: (call: IrExpr) => IrExpr;
}

/** pipeline(...) with function stages (pipeline.js). A function may
 * start the pipeline (a source function, called with `{ signal }`), may
 * end it (an async function whose promise's value reaches the callback or
 * the promise), and runs of async generator functions may sit between
 * streams; the last generator of a run that a stream follows is pumped
 * into that stream. Each stage's `source` parameter is typed as what the
 * pipeline passes it: makeAsyncIterable answers the previous stream
 * itself (a Readable is async iterable) or the previous stage's
 * generator. */
function lowerPipelineStages(
  lowerer: Lowerer,
  stageArgs: readonly ts.Expression[],
  loc: SrcLoc,
): PipelineStagesLowering {
  if (stageArgs.length > 52) {
    lowerer.noLowering(
      "pipeline with function stages and more than 52 stages",
      stageArgs[52]!,
      "split the pipeline",
    );
  }
  const streams: IrExpr[] = [];
  const stages: IrExpr[] = [];
  const helperArgs: IrExpr[] = [];
  let positions = 0;
  let mask = 0;
  let dest: 0 | 2 = 0;
  let destPromise: (IrType & { kind: "promise" }) | null = null;
  // What the next function stage receives: null before the first stage,
  // else the previous stream's type or the previous stage's generator.
  let srcT: IrType | null = null;
  // The streams and stages in argument order: the head lists all streams
  // before all stages, so when a stage precedes a stream the arguments
  // are bound to locals first, keeping JavaScript's evaluation order.
  const argOrder: { list: IrExpr[]; index: number }[] = [];
  for (let j = 0; j < stageArgs.length; j++) {
    const arg = stageArgs[j]!;
    const fn = pipelineStageFunction(lowerer, arg);
    const syncSourceFn =
      j === 0 &&
      fn !== null &&
      !ts.isArrowFunction(fn) &&
      fn.asteriskToken !== undefined &&
      !(fn.modifiers?.nodes ?? []).some((m) => m.kind === ts.SyntaxKind.AsyncKeyword);
    if (j === 0 && (syncSourceFn || (fn === null && iterableSourceType(lowerer, arg) !== null))) {
      const source = lowerIterableSource(lowerer, arg, syncSourceFn ? fn : null, loc);
      if (source === null) lowerer.noLowering("pipeline over this source", arg);
      positions += 1;
      argOrder.push({ list: stages, index: stages.length });
      stages.push(source!.closure);
      srcT = source!.out;
      continue;
    }
    if (fn === null) {
      if (srcT?.kind === "generator") {
        // the generator before this stream, pumped into it
        if (!fromGenChunk(lowerer, srcT.yieldT)) {
          lowerer.noLowering(
            `a pipeline stage yielding '${lowerer.fmt(srcT.yieldT)}'`,
            stageArgs[j - 1]!,
            "stage values written to a stream are strings or Buffers",
          );
        }
        const helpers = fromGenHelpers(lowerer, srcT, loc);
        if (!helpers)
          lowerer.noLowering("a pipeline stage with this generator type", stageArgs[j - 1]!);
        helperArgs.push(helpers![0]!, helpers![1]!, helpers![2]!);
      }
      let stream: IrExpr;
      try {
        stream = lowerStreamArg(lowerer, arg, "pipeline");
      } catch (e) {
        if (e instanceof StreamArgTypeThrow) lowerer.noLowering("pipeline over this value", arg);
        throw e;
      }
      argOrder.push({ list: streams, index: streams.length });
      streams.push(stream);
      srcT = stream.type;
      continue;
    }
    const isLast = j === stageArgs.length - 1;
    const isAsync = (fn.modifiers?.nodes ?? []).some((m) => m.kind === ts.SyntaxKind.AsyncKeyword);
    const isGen = !ts.isArrowFunction(fn) && fn.asteriskToken !== undefined;
    if (isLast && isGen) {
      // pipeline() pumps it into an object-mode PassThrough, whose
      // buffering decides when the pipeline finishes
      lowerer.noLowering(
        "a pipeline destination that is an async generator function",
        arg,
        "end the pipeline with a stream or an async function (source) { for await (const chunk of source) ... }",
      );
    }
    if (!isAsync || (!isGen && !isLast)) {
      lowerer.noLowering(
        isLast
          ? "a pipeline destination that is not an async function"
          : srcT === null
            ? "a pipeline source function that is not an async generator function"
            : "pipeline stages that are not async generator functions",
        arg,
        "write the stage as async function* (source) { for await (const chunk of source) ... }",
      );
    }
    const optionsAt = srcT === null ? 0 : 1;
    if (fn.parameters.nodes.length > optionsAt + 1) {
      lowerer.noLowering(
        "pipeline stages with parameters after the options argument",
        fn.parameters.nodes[optionsAt + 1]!,
        "a stage takes the source and { signal }",
      );
    }
    const lowered = lowerStageFunction(lowerer, fn, srcT);
    const params = lowered.closure.type.kind === "func" ? lowered.closure.type.params : [];
    if (params.length > optionsAt) {
      if (params[optionsAt]!.kind !== "dyn") {
        lowerer.noLowering(
          "a pipeline stage's options argument with this type",
          fn.parameters.nodes[optionsAt]!,
          "type it as { signal: AbortSignal }",
        );
      }
      mask |= 1 << stages.length;
    }
    positions += 2 ** j;
    argOrder.push({ list: stages, index: stages.length });
    stages.push(lowered.closure);
    if (lowered.out.kind === "promise") {
      dest = 2;
      destPromise = lowered.out;
      srcT = null;
    } else {
      srcT = lowered.out;
    }
  }
  if (dest === 2) {
    const valueT = destPromise!.inner;
    if (
      valueT.kind !== "void" &&
      !canConvertToDyn(
        valueT,
        (id) => lowerer.shapes.get(id),
        (id) => lowerer.unions.get(id),
      )
    ) {
      lowerer.noLowering(
        `a pipeline destination resolving to '${lowerer.fmt(valueT)}'`,
        stageArgs[stageArgs.length - 1]!,
      );
    }
    helperArgs.push(pipelineBoxHelper(lowerer, destPromise!, loc));
  }
  const argDecls: IrStmt[] = [];
  const firstStage = argOrder.findIndex((a) => a.list === stages);
  if (firstStage >= 0 && argOrder.slice(firstStage).some((a) => a.list === streams)) {
    for (const a of argOrder) {
      const init = a.list[a.index]!;
      const local = lowerer.declareHiddenLocal("%pipelineArg", init.type);
      argDecls.push({ kind: "varDecl", localId: local.id, init, loc: init.loc });
      a.list[a.index] = varRef(local.id, init.type, init.loc);
    }
  }
  const bindArgs = (call: IrExpr): IrExpr =>
    argDecls.length === 0
      ? call
      : { kind: "seqExpr", stmts: argDecls, result: call, type: call.type, loc };
  // SCR_PIPE_* flags: bits 1-2 the destination, bit 5 the signal and abort.
  const flags = (dest << 1) | (mask !== 0 ? 32 : 0);
  const head: IrExpr[] = [
    numLit(streams.length, loc),
    numLit(stages.length, loc),
    numLit(positions, loc),
    numLit(flags, loc),
    numLit(mask, loc),
    ...streams,
    ...stages,
    ...helperArgs,
  ];
  const last: IrType =
    dest === 2 ? { kind: "object", className: "%PassThrough" } : streams[streams.length - 1]!.type;
  if (mask === 0) return { args: head, last, dest, destPromise, wrap: bindArgs };
  // const ac = new AbortController(): its signal goes to the stages, and
  // finishImpl's ac.abort() runs through the abort closure.
  const ac = lowerer.declareHiddenLocal("%pipelineAbort", DYN);
  const acRef: IrExpr = { kind: "varRef", localId: ac.id, type: DYN, loc };
  const signal: IrExpr = {
    kind: "dynKeyGet",
    value: acRef,
    key: { kind: "strLit", value: "signal", type: STRING, loc },
    type: DYN,
    loc,
  };
  return {
    args: [...head, signal, pipelineAbortHelper(lowerer, acRef, loc)],
    last,
    dest,
    destPromise,
    wrap: (call) =>
      bindArgs({
        kind: "seqExpr",
        stmts: [
          {
            kind: "varDecl",
            localId: ac.id,
            init: { kind: "libCall", fn: "fetch.abortControllerNew", args: [], type: DYN, loc },
            loc,
          },
        ],
        result: call,
        type: call.type,
        loc,
      }),
  };
}

/** `(p) => p` boxed: a promise destination's promise as a checked-dynamic
 * promise, whose payload converts when the destination settles. Interned
 * per promise type. */
function pipelineBoxHelper(
  lowerer: Lowerer,
  promiseT: IrType & { kind: "promise" },
  loc: SrcLoc,
): IrExpr {
  const key = `pipelineBox:${typeKey(promiseT)}`;
  let name = lowerer.valueHelpers.get(key);
  if (!name) {
    name = keyedHelperName(lowerer, "%stream.pipelineBox", key);
    lowerer.valueHelpers.set(key, name);
    lowerer.liftedFns.push({
      name,
      params: [{ localId: "p.0", name: "p", type: promiseT }],
      returnType: DYN,
      locals: [{ id: "p.0", name: "p", type: promiseT, mutable: false }],
      body: [
        {
          kind: "return",
          value: { kind: "dynFrom", value: varRef("p.0", promiseT, loc), type: DYN, loc },
          loc,
        },
      ],
      loc,
    });
  }
  return { kind: "closure", fnName: name, captures: [], type: funcOf([promiseT], DYN), loc };
}

/** `() => ac.abort()` over the pipeline's AbortController: an interned
 * lifted function takes the controller and answers the closure. */
function pipelineAbortHelper(lowerer: Lowerer, ac: IrExpr, loc: SrcLoc): IrExpr {
  const key = "pipelineAbort";
  let name = lowerer.valueHelpers.get(key);
  const abortT = funcOf([], VOID);
  if (!name) {
    name = keyedHelperName(lowerer, "%stream.pipelineAbort", key);
    lowerer.valueHelpers.set(key, name);
    const acLocal: IrLocal = { id: "ac.0", name: "ac", type: DYN, mutable: false, boxed: true };
    const acRef = varRef(acLocal.id, DYN, loc);
    lowerer.liftedFns.push({
      name: `${name}.abort`,
      params: [],
      returnType: VOID,
      captures: [{ localId: acLocal.id, name: acLocal.name, type: DYN }],
      locals: [acLocal],
      body: [
        {
          kind: "exprStmt",
          expr: {
            kind: "dynInvoke",
            recv: acRef,
            method: "abort",
            calleeName: "ac.abort",
            args: [],
            type: DYN,
            loc,
          },
          loc,
        },
      ],
      loc,
    });
    lowerer.liftedFns.push({
      name,
      params: [{ localId: acLocal.id, name: acLocal.name, type: DYN }],
      returnType: abortT,
      locals: [acLocal],
      body: [
        {
          kind: "return",
          value: {
            kind: "closure",
            fnName: `${name}.abort`,
            captures: [acLocal.id],
            type: abortT,
            loc,
          },
          loc,
        },
      ],
      loc,
    });
  }
  return { kind: "call", callee: name, args: [ac], type: abortT, loc };
}

/** A function stage, lowered with its `source` parameter (absent for a
 * source function, srcT null) typed as what the pipeline passes (a
 * stream or the previous stage's generator). The source may only head
 * `for await` loops. Answers the closure and what it returns: an async
 * generator, or a promise for a destination async function. */
function lowerStageFunction(
  lowerer: Lowerer,
  fn: StageFunction,
  srcT: IrType | null,
): { closure: IrExpr; out: IrType & ({ kind: "generator" } | { kind: "promise" }) } {
  const param = srcT === null ? undefined : fn.parameters.nodes[0];
  const symbol =
    param && ts.isIdentifier(param.name)
      ? lowerer.checker.getSymbolAtLocation(param.name)
      : undefined;
  if (param && !symbol) {
    lowerer.noLowering(
      "pipeline stage parameters that are patterns",
      param,
      "name the source parameter",
    );
  }
  // The loop variables of the `for await` loops over the source.
  const chunkSymbols: ts.Symbol[] = [];
  if (symbol && fn.body) {
    const visit = (node: ts.Node): void => {
      if (
        ts.isIdentifier(node) &&
        node !== param!.name &&
        lowerer.checker.getSymbolAtLocation(node) === symbol
      ) {
        const parent = node.parent;
        if (
          !(
            parent &&
            ts.isForOfStatement(parent) &&
            parent.awaitModifier &&
            parent.expression === node
          )
        ) {
          lowerer.noLowering(
            "a pipeline stage's source used outside a for await loop head",
            node,
            "iterate the source with for await (const chunk of source)",
          );
        }
        const binding = ts.isVariableDeclarationList(parent.initializer)
          ? parent.initializer.declarations.nodes[0]?.name
          : undefined;
        const chunk =
          binding && ts.isIdentifier(binding)
            ? lowerer.checker.getSymbolAtLocation(binding)
            : undefined;
        if (chunk) chunkSymbols.push(chunk);
      }
      ts.forEachChild(node, visit);
    };
    visit(fn.body);
  }
  if (symbol) lowerer.stageSourceTypes.set(symbol, srcT!);
  // In JavaScript the checker types the chunks of a source that is the
  // previous stage's generator `any`; they read as the strings or Buffers
  // the generator yields, so their members take the string and Buffer
  // lowerings.
  const previousImplicit = lowerer.implicitParamTypes;
  const chunkType =
    srcT?.kind === "generator" && isJsSourceFile(ts.getSourceFileOfNode(fn))
      ? stageChunkCheckerType(lowerer, srcT.yieldT, fn)
      : null;
  if (chunkType && chunkSymbols.length > 0) {
    const implicit = new Map(previousImplicit ?? []);
    for (const chunk of chunkSymbols) implicit.set(chunk, chunkType);
    lowerer.implicitParamTypes = implicit;
  }
  try {
    const closure = lowerer.lowerLambda(fn);
    const out = closure.type.kind === "func" ? closure.type.ret : null;
    if (!(out?.kind === "generator" && out.async) && out?.kind !== "promise") {
      lowerer.noLowering("a pipeline stage that does not return an async generator", fn);
    }
    return { closure, out: out as IrType & ({ kind: "generator" } | { kind: "promise" }) };
  } finally {
    if (symbol) lowerer.stageSourceTypes.delete(symbol);
    lowerer.implicitParamTypes = previousImplicit;
  }
}

/** The checker type of a stage's string or Buffer chunks, or null for
 * other chunk types. */
function stageChunkCheckerType(lowerer: Lowerer, chunk: IrType, at: ts.Node): ts.Type | null {
  if (chunk.kind === "string") return lowerer.checker.getStringType();
  if (chunk.kind !== "bytes") return null;
  const buffer = lowerer.checker.resolveName("Buffer", ts.SymbolFlags.Type, at, false);
  return buffer ? lowerer.checker.getDeclaredTypeOfSymbol(buffer) : null;
}

/** `stream.compose(...streams)` over stream instances: a Duplex writing
 * to the first stream and reading from the last (scr_stream_compose). The
 * classes fix which positions can be readable and writable; a stream in
 * the wrong position, a single Readable or Writable (Duplex.from wraps
 * those), and functions, iterables or web streams have no lowering. */
function lowerStreamCompose(lowerer: Lowerer, call: ts.CallExpression, loc: SrcLoc): IrExpr {
  const args = call.arguments.nodes;
  const duplex: IrType = { kind: "object", className: "%Duplex" };
  if (args.some((a) => ts.isSpreadElement(a))) {
    lowerer.noLowering("compose with spread arguments", call, "pass the streams directly");
  }
  if (args.length === 0) {
    return nodeThrowExpr(
      1,
      "ERR_MISSING_ARGS",
      'The "streams" argument must be specified',
      duplex,
      loc,
    );
  }
  let streams: IrExpr[];
  try {
    streams = args.map((a) => lowerStreamArg(lowerer, a, "compose"));
  } catch (e) {
    if (e instanceof StreamArgTypeThrow) return e.expr;
    throw e;
  }
  const sides = streams.map((s) =>
    s.type.kind === "object" ? streamSidesOf(lowerer, lowerer.classes.get(s.type.className)) : null,
  );
  if (streams.length === 1) {
    // Duplex.from answers a duplex itself.
    if (sides[0] === "rw") return streams[0]!;
    lowerer.noLowering(
      `compose of a single ${sides[0] === "r" ? "Readable" : "Writable"}`,
      args[0]!,
      "Duplex.from wraps a lone Readable or Writable, which has no lowering yet; one Duplex, Transform or PassThrough answers itself",
    );
  }
  for (let i = 0; i < streams.length; i++) {
    const s = sides[i];
    const want =
      i < streams.length - 1 && s === "w" ? "readable" : i > 0 && s === "r" ? "writable" : null;
    if (want) {
      lowerer.noLowering(
        `compose with a stream that is not ${want} at position ${i}`,
        args[i]!,
        `Node throws ERR_INVALID_ARG_VALUE ('streams[${i}]' must be ${want}); every stream but the last must be readable and every stream but the first writable`,
      );
    }
  }
  return {
    kind: "libCall",
    fn: "stream.compose",
    args: [numLit(streams.length, loc), ...streams],
    type: duplex,
    loc,
  };
}

/* ── the method surface ───────────────────────────────────────────────── */

/* ── the Readable operators ──────────────────────────────────────────── */

/** The Readable operators (scr_stream_ops.c — Node's operators.js). */
export const STREAM_OPERATORS: ReadonlySet<string> = new Set([
  "map",
  "filter",
  "flatMap",
  "drop",
  "take",
  "toArray",
  "forEach",
  "some",
  "every",
  "find",
  "reduce",
]);

/** An operator callback as a checked-dynamic function value. Callbacks
 * that declare the options argument ({ signal }) are refused: the
 * AbortSignal Node passes there has no representation. map and flatMap
 * callbacks must produce strings or Buffers (flatMap: arrays of them, or
 * strings) — or checked-dynamic values, which the runtime checks. */
function lowerOperatorCallback(
  lowerer: Lowerer,
  node: ts.Expression,
  member: string,
  maxParams: number,
): IrExpr {
  const loc = locOf(node);
  const optionsParam = (at: ts.Node): never =>
    lowerer.noLowering(
      `${member} callbacks that declare the options argument`,
      at,
      "the { signal } argument has no lowering — take only the chunk",
    );
  if (
    (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) &&
    node.parameters.nodes.length > maxParams
  ) {
    optionsParam(node.parameters.nodes[maxParams]!);
  }
  const v = lowerer.lowerExpr(node);
  if (v.type.kind === "dyn") return v;
  if (
    v.type.kind !== "func" &&
    isJsSourceFile(ts.getSourceFileOfNode(node)) &&
    lowerer.dynConvertible(v.type)
  ) {
    // JavaScript passes any value; Node's validateFunction throws.
    return { kind: "dynFrom", value: v, type: DYN, loc };
  }
  if (v.type.kind !== "func") {
    lowerer.noLowering(
      `${member} with a '${lowerer.fmt(v.type)}' callback`,
      node,
      "pass a function",
    );
  }
  if (v.type.params.length > maxParams) optionsParam(node);
  if (member === "map" || member === "flatMap") {
    const ret = v.type.ret.kind === "promise" ? v.type.ret.inner : v.type.ret;
    const chunk = (t: IrType): boolean =>
      t.kind === "string" || t.kind === "dyn" || (t.kind === "bytes" && t.elem === "u8");
    const ok =
      member === "map"
        ? chunk(ret)
        : ret.kind === "dyn" || ret.kind === "string" || (ret.kind === "array" && chunk(ret.elem));
    if (!ok) {
      lowerer.noLowering(
        `${member} callbacks that return '${lowerer.fmt(ret)}'`,
        node,
        member === "map"
          ? "map results are stream chunks: strings or Buffers (object-mode streams of other values are not lowered)"
          : "flatMap results are arrays of strings or Buffers, or strings",
      );
    }
  }
  const getRecord = (id: string) => lowerer.shapes.get(id);
  const getUnion = (id: string) => lowerer.unions.get(id);
  if (!canBoxFuncIntoDyn(v.type, getRecord, getUnion)) {
    lowerer.noLowering(
      `${member} with this callback`,
      node,
      "the callback's parameter and result types must cross the checked-dynamic boundary",
    );
  }
  return { kind: "dynFrom", value: v, type: DYN, loc };
}

/** An operator's options (or reduce's initial value): an object literal
 * becomes a checked-dynamic object, checked-dynamic values pass through,
 * absent arguments are undefined. */
function lowerOperatorValue(
  lowerer: Lowerer,
  node: ts.Expression | undefined,
  what: string,
  loc: SrcLoc,
  literalObject: boolean,
): IrExpr {
  if (node === undefined) return dynUndefinedExpr(loc);
  if (literalObject && ts.isObjectLiteralExpression(node))
    return lowerDynObjectLiteral(lowerer, node);
  const v = lowerer.lowerExpr(node);
  if (v.type.kind === "dyn") return v;
  if (literalObject && v.type.kind !== "undefinedT" && v.type.kind !== "nullT") {
    lowerer.noLowering(
      `${what} that are not an object literal`,
      node,
      "write the options inline, e.g. { concurrency: 2 }",
    );
  }
  if (!lowerer.dynConvertible(v.type)) {
    lowerer.noLowering(`${what} of type '${lowerer.fmt(v.type)}'`, node);
  }
  return { kind: "dynFrom", value: v, type: DYN, loc: locOf(node) };
}

function lowerStreamOperator(
  lowerer: Lowerer,
  call: ts.CallExpression,
  access: ts.PropertyAccessExpression,
  member: string,
): IrExpr {
  const loc = locOf(call);
  const args = call.arguments.nodes;
  const recv = lowerer.lowerExpr(access.expression);
  const readable: IrType = { kind: "object", className: "%Readable" };
  const opts = (i: number): IrExpr =>
    lowerOperatorValue(lowerer, args[i], `${member} options`, loc, true);
  const fnArg = (maxParams: number): IrExpr => {
    if (args[0] === undefined) return dynUndefinedExpr(loc);
    return lowerOperatorCallback(lowerer, args[0], member, maxParams);
  };
  const lib = (fn: string, a: IrExpr[], type: IrType): IrExpr => ({
    kind: "libCall",
    fn: fn as IrLibFn,
    args: a,
    type,
    loc,
  });
  switch (member) {
    case "map":
    case "filter":
    case "flatMap": {
      const fn = fnArg(1);
      const fnName =
        member === "map"
          ? "readable.opMap"
          : member === "filter"
            ? "readable.opFilter"
            : "readable.opFlatMap";
      return lib(fnName, [recv, fn, opts(1)], readable);
    }
    case "drop":
    case "take": {
      const n = lowerOperatorValue(lowerer, args[0], `${member}'s count`, loc, false);
      return lib(
        member === "drop" ? "readable.opDrop" : "readable.opTake",
        [recv, n, opts(1)],
        readable,
      );
    }
    case "toArray":
      return lib("readable.opToArray", [recv, opts(0)], { kind: "promise", inner: DYN });
    case "forEach":
      return lib("readable.opForEach", [recv, fnArg(1), opts(1)], { kind: "promise", inner: VOID });
    case "some":
    case "every": {
      const fn = fnArg(1);
      return lib(member === "some" ? "readable.opSome" : "readable.opEvery", [recv, fn, opts(1)], {
        kind: "promise",
        inner: BOOL,
      });
    }
    case "find": {
      const t = lowerer.typeOf(call);
      const inner = lowerer.checker.getTypeArguments(t as ts.TypeReference)[0];
      if (inner && !(inner.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown))) {
        lowerer.noLowering(
          "find with a type-guard callback",
          call,
          "the result is a checked-dynamic value — use a boolean predicate and narrow the result",
        );
      }
      return lib("readable.opFind", [recv, fnArg(1), opts(1)], { kind: "promise", inner: DYN });
    }
    case "reduce": {
      const t = lowerer.typeOf(call);
      const resultTs = lowerer.checker.getTypeArguments(t as ts.TypeReference)[0];
      let kind = 0;
      let inner: IrType = DYN;
      if (resultTs && !(resultTs.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown))) {
        const mapped = lowerer.mapTypeOf(resultTs);
        if (mapped?.kind === "f64") {
          kind = 1;
          inner = F64;
        } else if (mapped?.kind === "bool") {
          kind = 2;
          inner = BOOL;
        } else if (mapped?.kind === "string") {
          kind = 3;
          inner = STRING;
        } else if (mapped?.kind !== "dyn") {
          lowerer.noLowering(
            `reduce with a '${mapped ? lowerer.fmt(mapped) : lowerer.checker.typeToString(resultTs)}' result`,
            call,
            "reduce results are numbers, booleans, strings, or checked-dynamic values",
          );
        }
      }
      const fn = fnArg(2);
      const init = lowerOperatorValue(lowerer, args[1], "reduce's initial value", loc, false);
      return lib(
        "readable.opReduce",
        [recv, fn, init, boolLit(args.length >= 2, loc), opts(2), numLit(kind, loc)],
        { kind: "promise", inner },
      );
    }
  }
  throw new InternalCompilerError(`unknown stream operator ${member}`);
}

/** The literal 'buffer' encoding on write()/end(): Node 24 takes it for a
 * Buffer chunk and throws ERR_UNKNOWN_ENCODING for a string chunk. */
function isBufferEncoding(lowerer: Lowerer, arg: ts.Expression | undefined): boolean {
  if (arg === undefined) return false;
  const t = lowerer.typeOf(arg);
  return t.isStringLiteralType() && t.value === "buffer";
}

/** The one supported encoding argument: utf8 (Node's default), as a
 * compile-time literal or absent. */
function checkUtf8Encoding(lowerer: Lowerer, member: string, arg: ts.Expression | undefined): void {
  if (arg === undefined) return;
  const t = lowerer.typeOf(arg);
  if (t.isStringLiteralType() && (t.value === "utf8" || t.value === "utf-8")) return;
  lowerer.noLowering(
    `${member} with a ${t.isStringLiteralType() ? `'${t.value}'` : "non-literal"} encoding`,
    arg,
    "utf8 (as a compile-time literal) is the supported encoding",
  );
}

/** `recv.<member>(...)` over a stream-rooted receiver. Returns null only
 * for members this spoke does not own. */
/** pipe()'s `{ end }` option: true when absent. */
function pipeEndOption(lowerer: Lowerer, options: ts.Expression | undefined, loc: SrcLoc): IrExpr {
  let end: IrExpr = boolLit(true, loc);
  if (options === undefined) return end;
  if (!ts.isObjectLiteralExpression(options)) {
    lowerer.noLowering(
      "pipe with a non-literal options argument",
      options,
      "{ end: <bool> } inline is the supported form",
    );
  }
  for (const prop of options.properties.nodes) {
    if (!ts.isPropertyAssignment(prop) || !ts.isIdentifier(prop.name) || prop.name.text !== "end") {
      lowerer.noLowering("a pipe option other than 'end'", prop);
    }
    end = lowerer.lowerExprExpecting(prop.initializer, BOOL);
  }
  return end;
}

/** `readable.pipe(process.stdout)`: the process stream joins the pipe as
 * an fd-backed Writable (stream.stdioWritable), and — like Node, which
 * never ends process.stdout or process.stderr from a pipe — the source's
 * end does not end it. pipe() answers the process stream itself. */
function pipeIntoStdio(
  lowerer: Lowerer,
  call: ts.CallExpression,
  access: ts.PropertyAccessExpression,
  target: IrExpr,
): IrExpr {
  const loc = locOf(call);
  // JS order: the receiver, then the destination, then the options.
  const receiverValue = lowerer.lowerExpr(access.expression);
  const source = lowerer.declareHiddenLocal("%pipeSource", receiverValue.type);
  const stdio = lowerer.declareHiddenLocal("%pipeStdio", target.type);
  const options = call.arguments.nodes[1];
  const stmts: IrStmt[] = [
    { kind: "varDecl", localId: source.id, init: receiverValue, loc },
    { kind: "varDecl", localId: stdio.id, init: target, loc },
  ];
  // The options literal still evaluates; its end flag has no effect here.
  if (options !== undefined) {
    stmts.push({ kind: "exprStmt", expr: pipeEndOption(lowerer, options, loc), loc });
  }
  const receiver: IrExpr = { kind: "varRef", localId: source.id, type: receiverValue.type, loc };
  const writable: IrType = { kind: "object", className: "%Writable" };
  stmts.push({
    kind: "exprStmt",
    expr: {
      kind: "libCall",
      fn: "readable.pipe",
      args: [
        receiver,
        {
          kind: "libCall",
          fn: "stream.stdioWritable",
          args: [{ kind: "varRef", localId: stdio.id, type: target.type, loc }],
          type: writable,
          loc,
        },
        boolLit(false, loc),
      ],
      type: writable,
      loc,
    },
    loc,
  });
  return {
    kind: "seqExpr",
    stmts,
    result: { kind: "varRef", localId: stdio.id, type: target.type, loc },
    type: target.type,
    loc,
  };
}

/** `readable.unpipe(untyped)`: a native destination (boxed) unpipes as a
 * typed one does; any other value unpipes the JavaScript destination a
 * pipe into it registered (scr_stream_dyn.c), or does nothing when there
 * is none, as Node's unpipe does for a destination it is not piped into.
 * The call answers the source. */
function unpipeDyn(lowerer: Lowerer, receiver: IrExpr, dst: IrExpr, loc: SrcLoc): IrExpr {
  noteUntypedStreamFlow(lowerer, null);
  const source = lowerer.declareHiddenLocal("%unpipeSource", receiver.type);
  const destination = lowerer.declareHiddenLocal("%unpipeDestination", dst.type);
  const sourceRef = varRef(source.id, receiver.type, loc);
  const destinationRef = varRef(destination.id, dst.type, loc);
  const stmts: IrStmt[] = [
    { kind: "varDecl", localId: source.id, init: receiver, loc },
    { kind: "varDecl", localId: destination.id, init: dst, loc },
  ];
  const unpipeNative = (native: IrExpr): IrStmt => ({
    kind: "exprStmt",
    expr: {
      kind: "libCall",
      fn: "readable.unpipe",
      args: [sourceRef, native],
      type: receiver.type,
      loc,
    },
    loc,
  });
  if (lowerer.dynNodeStreams) {
    stmts.push(
      dynNativeBranch(lowerer, destinationRef, "w", unpipeNative, {
        kind: "exprStmt",
        expr: {
          kind: "libCall",
          fn: "stream.unpipeDyn",
          args: [sourceRef, destinationRef],
          type: VOID,
          loc,
        },
        loc,
      }),
    );
  } else {
    stmts.push(
      unpipeNative({
        kind: "libCall",
        fn: "stream.unboxDyn",
        args: [
          destinationRef,
          strLit("unpipe destinations other than native streams are not supported yet", loc),
        ],
        type: { kind: "object", className: "%Duplex" },
        loc,
      }),
    );
  }
  return { kind: "seqExpr", stmts, result: sourceRef, type: receiver.type, loc };
}

/** The pipe() libCall for a destination of type `dst`. Under the general
 * stream representation a Writable slot can hold the converted
 * process.stdout / process.stderr, which a pipe never ends (as in Node), so
 * the pipe takes readable.pipeGeneral, which checks for them. */
function generalPipe(lowerer: Lowerer, dst: IrType): "readable.pipe" | "readable.pipeGeneral" {
  return lowerer.generalNodeStreams && dst.kind === "object" && dst.className === "%Writable"
    ? "readable.pipeGeneral"
    : "readable.pipe";
}

/** `readable.pipe(untyped)`: a checked-dynamic destination unwraps a boxed
 * native stream at run time (stream.unboxDyn; other values throw the
 * not-supported Error), and pipe() answers the destination value itself. */
function pipeIntoDyn(
  lowerer: Lowerer,
  call: ts.CallExpression,
  access: ts.PropertyAccessExpression,
  target: IrExpr,
): IrExpr {
  const loc = locOf(call);
  noteUntypedStreamFlow(lowerer, null);
  const receiverValue = lowerer.lowerExpr(access.expression);
  const source = lowerer.declareHiddenLocal("%pipeSource", receiverValue.type);
  const destination = lowerer.declareHiddenLocal("%pipeDestination", target.type);
  const stmts: IrStmt[] = [
    { kind: "varDecl", localId: source.id, init: receiverValue, loc },
    { kind: "varDecl", localId: destination.id, init: target, loc },
  ];
  const end = pipeEndOption(lowerer, call.arguments.nodes[1], loc);
  const duplex: IrType = { kind: "object", className: "%Duplex" };
  // Checked-dynamic stream slots (dyn-streams.ts): a JavaScript stream
  // object is a destination too, piped with Node's listener protocol.
  if (lowerer.dynNodeStreams) {
    const sourceRef: IrExpr = { kind: "varRef", localId: source.id, type: receiverValue.type, loc };
    const destinationRef: IrExpr = {
      kind: "varRef",
      localId: destination.id,
      type: target.type,
      loc,
    };
    const ending = lowerer.declareHiddenLocal("%pipeEnd", BOOL);
    stmts.push({ kind: "varDecl", localId: ending.id, init: end, loc });
    const endRef: IrExpr = { kind: "varRef", localId: ending.id, type: BOOL, loc };
    stmts.push(
      dynNativeBranch(
        lowerer,
        destinationRef,
        "w",
        (native) => ({
          kind: "exprStmt",
          expr: {
            kind: "libCall",
            // Checked-dynamic slots come with the general representation,
            // where a boxed native destination can be the converted
            // process.stdout (generalPipe).
            fn: "readable.pipeGeneral",
            args: [sourceRef, native, endRef],
            type: native.type,
            loc,
          },
          loc,
        }),
        {
          kind: "exprStmt",
          expr: {
            kind: "libCall",
            fn: "stream.pipeDyn",
            args: [sourceRef, lowerer.coerceToExpected(sourceRef, DYN), destinationRef, endRef],
            type: VOID,
            loc,
          },
          loc,
        },
      ),
    );
    return {
      kind: "seqExpr",
      stmts,
      result: destinationRef,
      type: target.type,
      loc,
    };
  }
  stmts.push({
    kind: "exprStmt",
    expr: {
      kind: "libCall",
      fn: lowerer.generalNodeStreams ? "readable.pipeGeneral" : "readable.pipe",
      args: [
        { kind: "varRef", localId: source.id, type: receiverValue.type, loc },
        {
          kind: "libCall",
          fn: "stream.unboxDyn",
          args: [
            { kind: "varRef", localId: destination.id, type: target.type, loc },
            strLit("pipe destinations other than native streams are not supported yet", loc),
          ],
          type: duplex,
          loc,
        },
        end,
      ],
      type: duplex,
      loc,
    },
    loc,
  });
  return {
    kind: "seqExpr",
    stmts,
    result: { kind: "varRef", localId: destination.id, type: target.type, loc },
    type: target.type,
    loc,
  };
}

export function lowerStreamMethodCall(
  lowerer: Lowerer,
  call: ts.CallExpression,
  access: ts.PropertyAccessExpression,
  info: ClassInfo,
): IrExpr | null {
  const member = access.name.text;
  if (STREAM_OPERATORS.has(member)) {
    const opSides = streamSidesOf(lowerer, info);
    if (opSides === "r" || opSides === "rw")
      return lowerStreamOperator(lowerer, call, access, member);
  }
  if (!STREAM_API_MEMBERS.has(member)) return null;
  const sides = streamSidesOf(lowerer, info);
  if (!sides) return null;
  const loc = locOf(call);
  const args = call.arguments.nodes;
  const readableSide = sides === "r" || sides === "rw";
  const writableSide = sides === "w" || sides === "rw";
  const cls = info.def.name.slice(1);

  const requireSide = (need: boolean, what: string): void => {
    if (!need) {
      lowerer.noLowering(
        `${what} on a ${cls} (the ${what.startsWith("write") || what === "end" || what === "cork" || what === "uncork" ? "writable" : "readable"} half is absent)`,
        call,
      );
    }
  };

  // Chunk classification for push/unshift/write/end. Union-typed chunks
  // over {Buffer, string, null} dispatch by tag at runtime — the
  // `push(more ? next : null)` idiom.
  const chunkKind = (node: ts.Expression): "bytes" | "string" | "null" | "union" | "dyn" => {
    if (node.kind === ts.SyntaxKind.NullKeyword) return "null";
    const t = lowerer.mapTypeOf(lowerer.typeOf(node));
    if (t?.kind === "bytes" && t.elem === "u8") return "bytes";
    if (t?.kind === "string") return "string";
    if (t?.kind === "nullT") return "null";
    if (t?.kind === "dyn") {
      // The JS lane's any-typed chunk: the runtime dispatches by dyn tag
      // (bytes / string / null; anything else is the write TypeError).
      return "dyn";
    }
    if (t?.kind === "union") {
      const def = lowerer.unions.get(t.unionId);
      if (
        def &&
        def.arms.every(
          (a) =>
            (a.kind === "bytes" && a.elem === "u8") || a.kind === "string" || a.kind === "nullT",
        )
      ) {
        return "union";
      }
    }
    if (t === null) {
      // A checker-untyped chunk (the JS lane's `t.write(x.toString())`
      // shapes): the LOWERING may still land on a supported kind — probe
      // it (the probe's IR is discarded; the caller re-lowers the node).
      const probed = tryLowerExpression(lowerer, node);
      if (probed?.type.kind === "string") return "string";
      if (probed?.type.kind === "bytes" && probed.type.elem === "u8") return "bytes";
      if (probed?.type.kind === "dyn") return "dyn";
      if (probed?.type.kind === "nullT") return "null";
    }
    lowerer.noLowering(
      `${member} with a '${t ? lowerer.fmt(t) : "?"}' chunk`,
      node,
      "chunks are Buffers or utf8 strings — or unions of those with null (objectMode is not lowered)",
    );
  };

  if (member === "push" || member === "unshift") {
    requireSide(readableSide, member);
    if (args.length === 0 || args.length > 2) {
      lowerer.noLowering(
        `${member} with ${args.length} arguments`,
        call,
        'the supported forms are (chunk) and (chunk, "utf8")',
      );
    }
    // push(chunk, enc) with a LITERAL encoding: the per-call decode
    // (Buffer.from(chunk, enc)) — an explicit encoding (utf8 included)
    // overrides the stream's defaultEncoding; unknown literals throw
    // Node's ERR_UNKNOWN_ENCODING when the push evaluates. unshift keeps
    // the utf8-only fence below.
    if (member === "push" && args[1] !== undefined && chunkKind(args[0]!) === "string") {
      const t = lowerer.typeOf(args[1]!);
      if (t.isStringLiteralType()) {
        const canonical = knownBufEncoding(t.value);
        if (canonical === undefined) {
          return nodeThrowExpr(
            1,
            "ERR_UNKNOWN_ENCODING",
            `Unknown encoding: ${t.value}`,
            BOOL,
            loc,
          );
        }
        const receiver = lowerer.lowerExpr(access.expression);
        const chunk = lowerer.lowerExprExpecting(args[0]!, STRING);
        return {
          kind: "libCall",
          fn: "readable.pushStrEnc",
          args: [receiver, chunk, strLit(canonical, loc)],
          type: BOOL,
          loc,
        };
      }
    }
    checkUtf8Encoding(lowerer, member, args[1]);
    const kind = chunkKind(args[0]!);
    if ((kind === "null" || kind === "union" || kind === "dyn") && member === "unshift") {
      lowerer.noLowering(
        kind === "null" ? "unshift(null)" : "unshift with a nullable or dynamic chunk",
        call,
        "EOF signals through push(null)",
      );
    }
    const receiver = lowerer.lowerExpr(access.expression);
    if (kind === "null") {
      return { kind: "libCall", fn: "readable.pushNull", args: [receiver], type: BOOL, loc };
    }
    if (kind === "dyn") {
      const chunk = lowerer.lowerExprExpecting(args[0]!, DYN);
      return { kind: "libCall", fn: "readable.pushDyn", args: [receiver, chunk], type: BOOL, loc };
    }
    if (kind === "union") {
      // The lowered value may have collapsed to one arm (checker
      // narrowing) — re-dispatch on its IR type.
      const chunk = lowerer.lowerExpr(args[0]!);
      if (chunk.type.kind === "union") {
        return { kind: "libCall", fn: "readable.pushU", args: [receiver, chunk], type: BOOL, loc };
      }
      if (chunk.type.kind === "bytes") {
        return { kind: "libCall", fn: "readable.push", args: [receiver, chunk], type: BOOL, loc };
      }
      if (chunk.type.kind === "string") {
        return {
          kind: "libCall",
          fn: "readable.pushStr",
          args: [receiver, chunk],
          type: BOOL,
          loc,
        };
      }
      return { kind: "libCall", fn: "readable.pushNull", args: [receiver], type: BOOL, loc };
    }
    const chunk =
      kind === "bytes"
        ? lowerer.lowerExprExpecting(args[0]!, BYTES)
        : lowerer.lowerExprExpecting(args[0]!, STRING);
    const fn =
      member === "push"
        ? kind === "bytes"
          ? "readable.push"
          : "readable.pushStr"
        : kind === "bytes"
          ? "readable.unshift"
          : "readable.unshiftStr";
    return {
      kind: "libCall",
      fn,
      args: [receiver, chunk],
      type: member === "push" ? BOOL : VOID,
      loc,
    };
  }

  if (member === "read") {
    requireSide(readableSide, "read");
    if (args.length > 1) lowerer.noLowering(`read with ${args.length} arguments`, call);
    const receiver = lowerer.lowerExpr(access.expression);
    const size = args[0] ? lowerer.lowerExprExpecting(args[0], F64) : numLit(-1, loc);
    const type: IrType = unionOf(lowerer, [BYTES, { kind: "nullT" }]);
    const read: IrExpr = {
      kind: "libCall",
      fn: "readable.read",
      args: [receiver, size],
      type,
      loc,
    };
    return lowerer.maybeNarrow(read, call);
  }

  if (member === "pause" || member === "resume") {
    requireSide(readableSide, member);
    if (args.length !== 0) lowerer.noLowering(`${member} with arguments`, call);
    const receiver = lowerer.lowerExpr(access.expression);
    return {
      kind: "libCall",
      fn: member === "pause" ? "readable.pause" : "readable.resume",
      args: [receiver],
      type: receiver.type,
      loc,
    };
  }

  if (member === "isPaused") {
    requireSide(readableSide, "isPaused");
    if (args.length !== 0) lowerer.noLowering(`isPaused with arguments`, call);
    const receiver = lowerer.lowerExpr(access.expression);
    return { kind: "libCall", fn: "readable.isPaused", args: [receiver], type: BOOL, loc };
  }

  if (member === "pipe") {
    requireSide(readableSide, "pipe");
    if (args.length === 0 || args.length > 2) {
      lowerer.noLowering(
        `pipe with ${args.length} arguments`,
        call,
        "the supported forms are (destination) and (destination, { end })",
      );
    }
    // A Hash, Hmac, Cipheriv or Decipheriv destination pipes into its
    // Transform, and pipe() answers the value itself (the receiver
    // evaluates first, as in JS).
    if (isValueStream(lowerer, args[0]!)) {
      const receiverValue = lowerer.lowerExpr(access.expression);
      const source = lowerer.declareHiddenLocal("%pipeSource", receiverValue.type);
      const hashValue = lowerer.lowerExpr(args[0]!);
      const hash = lowerer.declareHiddenLocal("%pipeHash", hashValue.type);
      const end = pipeEndOption(lowerer, args[1], loc);
      return {
        kind: "seqExpr",
        stmts: [
          { kind: "varDecl", localId: source.id, init: receiverValue, loc },
          { kind: "varDecl", localId: hash.id, init: hashValue, loc },
          {
            kind: "exprStmt",
            expr: {
              kind: "libCall",
              fn: "readable.pipe",
              args: [
                { kind: "varRef", localId: source.id, type: receiverValue.type, loc },
                valueStreamOf(
                  { kind: "varRef", localId: hash.id, type: hashValue.type, loc },
                  true,
                ),
                end,
              ],
              type: { kind: "object", className: "%Transform" },
              loc,
            },
            loc,
          },
        ],
        result: { kind: "varRef", localId: hash.id, type: hashValue.type, loc },
        type: hashValue.type,
        loc,
      };
    }
    const target = lowerer.lowerExpr(args[0]!);
    if (target.type.kind === "procStream") return pipeIntoStdio(lowerer, call, access, target);
    if (target.type.kind === "dyn") return pipeIntoDyn(lowerer, call, access, target);
    const dst = target;
    const dstInfo =
      dst.type.kind === "object" ? lowerer.classes.get(dst.type.className) : undefined;
    const dstSides = streamSidesOf(lowerer, dstInfo);
    if (dstSides !== "w" && dstSides !== "rw") {
      requestGeneralStreamSurface(lowerer, args[0]!);
      lowerer.noLowering(
        `pipe into a '${lowerer.fmt(dst.type)}'`,
        args[0]!,
        "the destination must be a stream Writable/Duplex, process.stdout or process.stderr (sockets are not pipe destinations yet)",
      );
    }
    const end = pipeEndOption(lowerer, args[1], loc);
    const receiver = lowerer.lowerExpr(access.expression);
    return {
      kind: "libCall",
      fn: generalPipe(lowerer, dst.type),
      args: [receiver, dst, end],
      type: dst.type,
      loc,
    };
  }

  if (member === "unpipe") {
    requireSide(readableSide, "unpipe");
    if (args.length > 1) lowerer.noLowering(`unpipe with ${args.length} arguments`, call);
    const receiver = lowerer.lowerExpr(access.expression);
    if (args[0] !== undefined) {
      const dst = lowerer.lowerExpr(args[0]);
      if (dst.type.kind === "dyn") return unpipeDyn(lowerer, receiver, dst, loc);
      const dstInfo =
        dst.type.kind === "object" ? lowerer.classes.get(dst.type.className) : undefined;
      const dstSides = streamSidesOf(lowerer, dstInfo);
      if (dstSides !== "w" && dstSides !== "rw") {
        lowerer.noLowering(`unpipe of a '${lowerer.fmt(dst.type)}'`, args[0]);
      }
      return {
        kind: "libCall",
        fn: "readable.unpipe",
        args: [receiver, dst],
        type: receiver.type,
        loc,
      };
    }
    // Checked-dynamic slots: unpipe() also unpipes the JavaScript
    // destinations stream.pipeDyn registered (stream.unpipeDyn with an
    // undefined destination), as Node's unpipe() empties every pipe.
    if (lowerer.dynNodeStreams) {
      const source = lowerer.declareHiddenLocal("%unpipeSource", receiver.type);
      const sourceRef = varRef(source.id, receiver.type, loc);
      return {
        kind: "seqExpr",
        stmts: [
          { kind: "varDecl", localId: source.id, init: receiver, loc },
          {
            kind: "exprStmt",
            expr: {
              kind: "libCall",
              fn: "readable.unpipe",
              args: [sourceRef],
              type: receiver.type,
              loc,
            },
            loc,
          },
          {
            kind: "exprStmt",
            expr: {
              kind: "libCall",
              fn: "stream.unpipeDyn",
              args: [sourceRef, dynUndefinedExpr(loc)],
              type: VOID,
              loc,
            },
            loc,
          },
        ],
        result: sourceRef,
        type: receiver.type,
        loc,
      };
    }
    return { kind: "libCall", fn: "readable.unpipe", args: [receiver], type: receiver.type, loc };
  }

  if (member === "destroy") {
    if (args.length > 1) lowerer.noLowering(`destroy with ${args.length} arguments`, call);
    const receiver = lowerer.lowerExpr(access.expression);
    if (args[0] !== undefined) {
      const err = lowerer.lowerExpr(args[0]);
      const rootsAtError = (t: IrType): boolean => {
        if (t.kind !== "object") return false;
        for (let c: ClassInfo | null = lowerer.classes.get(t.className) ?? null; c; c = c.base) {
          if (c.def.name === "%Error") return true;
        }
        return false;
      };
      if (!rootsAtError(err.type)) {
        lowerer.noLowering(
          `destroy with a '${lowerer.fmt(err.type)}' argument`,
          args[0],
          "the supported argument is an Error-hierarchy instance",
        );
      }
      return {
        kind: "libCall",
        fn: "stream.destroyErr",
        args: [receiver, lowerer.upcastTo(err, "%Error")],
        type: receiver.type,
        loc,
      };
    }
    return { kind: "libCall", fn: "stream.destroy", args: [receiver], type: receiver.type, loc };
  }

  if (member === "write") {
    requireSide(writableSide, "write");
    if (args.length === 0 || args.length > 3) {
      lowerer.noLowering(`write with ${args.length} arguments`, call);
    }
    const kind = chunkKind(args[0]!);
    if (kind === "null") lowerer.noLowering("write(null)", call, "end() finishes a writable");
    if (kind === "dyn") {
      if (args.length > 1)
        lowerer.noLowering("write with a dynamic chunk and more arguments", call);
      const receiver = lowerer.lowerExpr(access.expression);
      const chunk = lowerer.lowerExprExpecting(args[0]!, DYN);
      return { kind: "libCall", fn: "writable.writeDyn", args: [receiver, chunk], type: BOOL, loc };
    }
    if (kind === "union") {
      // Bytes/string arms dispatch at runtime; a null arm value throws
      // Node's ERR_STREAM_NULL_VALUES TypeError in the runtime. The
      // lowered value may have collapsed to one arm (checker narrowing) —
      // re-dispatch on its IR type.
      if (args.length > 1) lowerer.noLowering("write with a union chunk and more arguments", call);
      const receiver = lowerer.lowerExpr(access.expression);
      const chunk = lowerer.lowerExpr(args[0]!);
      const fn =
        chunk.type.kind === "union"
          ? "writable.writeU"
          : chunk.type.kind === "string"
            ? "writable.writeStr"
            : "writable.write";
      if (chunk.type.kind === "nullT")
        lowerer.noLowering("write(null)", call, "end() finishes a writable");
      return { kind: "libCall", fn, args: [receiver, chunk], type: BOOL, loc };
    }
    // Disambiguate (chunk, cb?) vs (chunk, encoding, cb?) by the second
    // argument's static type.
    let cbArg: ts.Expression | undefined;
    if (args.length >= 2 && isBufferEncoding(lowerer, args[1])) {
      if (kind !== "bytes")
        return nodeThrowExpr(1, "ERR_UNKNOWN_ENCODING", "Unknown encoding: buffer", BOOL, loc);
      cbArg = args[2];
    } else if (args.length === 2) {
      const t = lowerer.mapTypeOf(lowerer.typeOf(args[1]!));
      if (t?.kind === "string") checkUtf8Encoding(lowerer, "write", args[1]);
      else cbArg = args[1];
    } else if (args.length === 3) {
      checkUtf8Encoding(lowerer, "write", args[1]);
      cbArg = args[2];
    }
    const receiver = lowerer.lowerExpr(access.expression);
    const chunk =
      kind === "bytes"
        ? lowerer.lowerExprExpecting(args[0]!, BYTES)
        : lowerer.lowerExprExpecting(args[0]!, STRING);
    const fn = kind === "bytes" ? "writable.write" : "writable.writeStr";
    if (cbArg !== undefined) {
      const cb = callbackDeclaresParameters(cbArg)
        ? null
        : lowerer.lowerExprExpecting(cbArg, funcOf([], VOID));
      if (cb === null || cb.type.kind !== "func" || cb.type.params.length > 0) {
        lowerer.noLowering(
          "write completion callbacks taking the error argument",
          cbArg,
          "() => void callbacks are supported (listen for 'error' to observe failures)",
        );
      }
      return { kind: "libCall", fn, args: [receiver, chunk, cb], type: BOOL, loc };
    }
    return { kind: "libCall", fn, args: [receiver, chunk], type: BOOL, loc };
  }

  if (member === "end") {
    requireSide(writableSide, "end");
    if (args.length > 3) lowerer.noLowering(`end with ${args.length} arguments`, call);
    // Forms: (), (cb), (chunk), (chunk, cb), (chunk, encoding, cb).
    let chunkNode: ts.Expression | undefined;
    let cbArg: ts.Expression | undefined;
    if (args.length === 1) {
      const t = lowerer.mapTypeOf(lowerer.typeOf(args[0]!));
      if (t?.kind === "func") cbArg = args[0];
      else chunkNode = args[0];
    } else if (args.length >= 2 && isBufferEncoding(lowerer, args[1])) {
      chunkNode = args[0];
      const endKind = chunkKind(args[0]!);
      if (endKind === "string") {
        const endT = lowerer.mapTypeOf(lowerer.typeOf(call)) ?? DYN;
        return nodeThrowExpr(1, "ERR_UNKNOWN_ENCODING", "Unknown encoding: buffer", endT, loc);
      }
      if (endKind !== "bytes") checkUtf8Encoding(lowerer, "end", args[1]);
      cbArg = args[2];
    } else if (args.length === 2) {
      chunkNode = args[0];
      const t = lowerer.mapTypeOf(lowerer.typeOf(args[1]!));
      if (t?.kind === "string") checkUtf8Encoding(lowerer, "end", args[1]);
      else cbArg = args[1];
    } else if (args.length === 3) {
      chunkNode = args[0];
      checkUtf8Encoding(lowerer, "end", args[1]);
      cbArg = args[2];
    }
    const receiver = lowerer.lowerExpr(access.expression);
    let flags = 0;
    const tail: IrExpr[] = [];
    if (chunkNode !== undefined) {
      const kind = chunkKind(chunkNode);
      if (kind === "null" || kind === "union") lowerer.noLowering("end(null)", call);
      flags |= kind === "bytes" ? 1 : kind === "dyn" ? 8 : 2;
      tail.push(
        kind === "bytes"
          ? lowerer.lowerExprExpecting(chunkNode, BYTES)
          : kind === "dyn"
            ? lowerer.lowerExprExpecting(chunkNode, DYN)
            : lowerer.lowerExprExpecting(chunkNode, STRING),
      );
    }
    if (cbArg !== undefined) {
      const cb = callbackDeclaresParameters(cbArg)
        ? null
        : lowerer.lowerExprExpecting(cbArg, funcOf([], VOID));
      if (cb === null || cb.type.kind !== "func" || cb.type.params.length > 0) {
        lowerer.noLowering(
          "end callbacks with parameters",
          cbArg,
          "() => void callbacks are supported",
        );
      }
      flags |= 4;
      tail.push(cb);
    }
    return {
      kind: "libCall",
      fn: "writable.end",
      args: [receiver, numLit(flags, loc), ...tail],
      type: receiver.type,
      loc,
    };
  }

  if (member === "cork" || member === "uncork") {
    requireSide(writableSide, member);
    if (args.length !== 0) lowerer.noLowering(`${member} with arguments`, call);
    const receiver = lowerer.lowerExpr(access.expression);
    return {
      kind: "libCall",
      fn: member === "cork" ? "writable.cork" : "writable.uncork",
      args: [receiver],
      type: VOID,
      loc,
    };
  }

  if (member === "setEncoding") {
    requireSide(readableSide, "setEncoding");
    if (args.length !== 1) {
      lowerer.noLowering(
        `setEncoding with ${args.length} arguments`,
        call,
        "one literal encoding is the supported form",
      );
    }
    const enc = bufEncoding(lowerer, "setEncoding", args[0]!);
    const receiver = lowerer.lowerExpr(access.expression);
    return {
      kind: "libCall",
      fn: "readable.setEncoding",
      args: [receiver, strLit(enc, loc)],
      type: receiver.type,
      loc,
    };
  }

  if (member === "setDefaultEncoding") {
    // The write-side default: utf8 IS the default — admit it; other
    // encodings would change what write(string) means.
    requireSide(writableSide, "setDefaultEncoding");
    const t = args[0] ? lowerer.typeOf(args[0]) : null;
    if (t?.isStringLiteralType() && (t.value === "utf8" || t.value === "utf-8")) {
      return lowerer.lowerExpr(access.expression);
    }
    lowerer.noLowering(
      "setDefaultEncoding",
      call,
      "utf8 (the default, as a compile-time literal) is the supported write-side string encoding",
    );
  }

  return null;
}

/* ── the internal-state read surface (_readableState/_writableState) ──── */

/** The `s._readableState.<name>` / `s._writableState.<name>` READS the
 * suite's asserts use: a read-only compat VIEW over the real runtime
 * state — each supported name maps onto a state field the runtime
 * actually keeps, so the answers cannot lie. Writes and the object-
 * valued members (pipes, awaitDrainWriters, buffered entries) keep
 * their fences. Node's `ending`/`ended` distinction inside end() and
 * the per-side errored slots collapse onto the shared fields here
 * (SEMANTICS.md). */
const RS_BOOL_PROPS: ReadonlySet<string> = new Set([
  "ended",
  "endEmitted",
  "destroyed",
  "errorEmitted",
  "emittedReadable",
  "needReadable",
  "reading",
  "readableListening",
  "resumeScheduled",
  "objectMode",
  "constructed",
  "closed",
]);
const RS_NUM_PROPS: ReadonlySet<string> = new Set(["length", "highWaterMark"]);
const WS_BOOL_PROPS: ReadonlySet<string> = new Set([
  "ended",
  "ending",
  "finished",
  "destroyed",
  "errorEmitted",
  "needDrain",
  "objectMode",
  "constructed",
  "closed",
  "prefinished",
]);
const WS_NUM_PROPS: ReadonlySet<string> = new Set([
  "length",
  "highWaterMark",
  "corked",
  "bufferedRequestCount",
]);

export function lowerStreamStateProperty(
  lowerer: Lowerer,
  expr: ts.PropertyAccessExpression,
): IrExpr | null {
  if (expr.questionDotToken) return null;
  const inner = expr.expression;
  if (!ts.isPropertyAccessExpression(inner) || inner.questionDotToken) return null;
  const stateName = inner.name.text;
  if (stateName !== "_readableState" && stateName !== "_writableState") return null;
  let recvT: IrType | null;
  try {
    recvT = lowerer.mapTypeOf(lowerer.typeOf(inner.expression));
  } catch {
    return null;
  }
  if (recvT?.kind !== "object") return null;
  const info = lowerer.classes.get(recvT.className);
  const sides = streamSidesOf(lowerer, info);
  if (!sides) return null;
  const loc = locOf(expr);
  const readable = stateName === "_readableState";
  if (readable ? sides === "w" : sides === "r") {
    lowerer.noLowering(`${stateName} on a ${recvT.className.slice(1)} (that half is absent)`, expr);
  }
  const name = expr.name.text;
  const prefix = readable ? "rs:" : "ws:";
  const receiver = () => lowerer.lowerExpr(inner.expression);
  if (name === "flowing" && readable) {
    const type: IrType = unionOf(lowerer, [BOOL, { kind: "nullT" }]);
    const read: IrExpr = { kind: "libCall", fn: "readable.flowing", args: [receiver()], type, loc };
    return lowerer.maybeNarrow(read, expr);
  }
  if (name === "errored") {
    const type: IrType = unionOf(lowerer, [
      { kind: "object", className: "%Error" },
      { kind: "nullT" },
    ]);
    const read: IrExpr = { kind: "libCall", fn: "stream.errored", args: [receiver()], type, loc };
    return lowerer.maybeNarrow(read, expr);
  }
  const bools = readable ? RS_BOOL_PROPS : WS_BOOL_PROPS;
  const nums = readable ? RS_NUM_PROPS : WS_NUM_PROPS;
  if (bools.has(name) || nums.has(name)) {
    return {
      kind: "libCall",
      fn: "stream.prop",
      args: [receiver(), strLit(prefix + name, loc)],
      type: bools.has(name) ? BOOL : F64,
      loc,
    };
  }
  lowerer.noLowering(
    `reading ${stateName}.${name}`,
    expr,
    "the lowered internal-state view covers the scalar fields (length, ended, flowing, errorEmitted, ...) — object-valued members like pipes and buffered entries have no lowering",
  );
}

/* ── the property surface ─────────────────────────────────────────────── */

const READABLE_BOOL_PROPS: ReadonlySet<string> = new Set(["readable", "readableEnded"]);
const WRITABLE_BOOL_PROPS: ReadonlySet<string> = new Set([
  "writable",
  "writableEnded",
  "writableFinished",
  "writableNeedDrain",
]);
const SHARED_BOOL_PROPS: ReadonlySet<string> = new Set(["destroyed", "closed"]);
const READABLE_NUM_PROPS: ReadonlySet<string> = new Set([
  "readableLength",
  "readableHighWaterMark",
]);
const WRITABLE_NUM_PROPS: ReadonlySet<string> = new Set([
  "writableLength",
  "writableHighWaterMark",
  "writableCorked",
]);

/** Property reads on stream-rooted receivers (`r.readableEnded`,
 * `w.destroyed`, ...). Null for names this spoke does not own. */
export function lowerStreamProperty(
  lowerer: Lowerer,
  expr: ts.PropertyAccessExpression,
  info: ClassInfo,
): IrExpr | null {
  const sides = streamSidesOf(lowerer, info);
  if (!sides) return null;
  const name = expr.name.text;
  const loc = locOf(expr);
  const readableSide = sides === "r" || sides === "rw";
  const writableSide = sides === "w" || sides === "rw";

  const propCall = (type: IrType): IrExpr => ({
    kind: "libCall",
    fn: "stream.prop",
    args: [lowerer.lowerExpr(expr.expression), strLit(name, loc)],
    type,
    loc,
  });

  if (
    (readableSide && READABLE_BOOL_PROPS.has(name)) ||
    (writableSide && WRITABLE_BOOL_PROPS.has(name)) ||
    SHARED_BOOL_PROPS.has(name)
  ) {
    return propCall(BOOL);
  }
  if (
    (readableSide && READABLE_NUM_PROPS.has(name)) ||
    (writableSide && WRITABLE_NUM_PROPS.has(name))
  ) {
    return propCall(F64);
  }
  if (name === "readableFlowing" && readableSide) {
    const type: IrType = unionOf(lowerer, [BOOL, { kind: "nullT" }]);
    const read: IrExpr = {
      kind: "libCall",
      fn: "readable.flowing",
      args: [lowerer.lowerExpr(expr.expression)],
      type,
      loc,
    };
    return lowerer.maybeNarrow(read, expr);
  }
  if (name === "errored") {
    const type: IrType = unionOf(lowerer, [
      { kind: "object", className: "%Error" },
      { kind: "nullT" },
    ]);
    const read: IrExpr = {
      kind: "libCall",
      fn: "stream.errored",
      args: [lowerer.lowerExpr(expr.expression)],
      type,
      loc,
    };
    return lowerer.maybeNarrow(read, expr);
  }
  if (name === "readableObjectMode" && readableSide) {
    // Runtime state: Readable.from streams answer true (object entries).
    return propCall(BOOL);
  }
  if (name === "writableObjectMode" && writableSide) {
    // objectMode construction fences, so the answer is compile-time false.
    return boolLit(false, loc);
  }
  if (name === "allowHalfOpen" && sides === "rw") {
    return propCall(BOOL);
  }
  return null;
}

/** Whether an inline completion callback declares a parameter. Node calls
 * write and end callbacks with an error argument (null on success), but the
 * native callback receives none, so the parameter would read undefined
 * where Node passes null or the error. A function literal with parameters
 * would otherwise adapt to the zero-parameter slot silently. */
function callbackDeclaresParameters(node: ts.Expression): boolean {
  let callback = node;
  while (ts.isParenthesizedExpression(callback)) callback = callback.expression;
  return (
    (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback)) &&
    callback.parameters.nodes.length > 0
  );
}
