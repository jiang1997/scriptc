import { expect, test } from "vitest";
import {
  BOOL,
  F64,
  VOID,
  type IrExpr,
  type IrFunction,
  type IrLocal,
  type IrModule,
  type IrStmt,
  type IrType,
} from "../../ir/ir.js";
import { analyzeIntegerRanges } from "../../ir/integer-ranges.js";
import { matchIntegerCountedForLoop } from "../../ir/integer-loops.js";
import { findInitializedByteLoopBindings } from "./byte-windows.js";
import { matchBytesLoopVersion, type BytesLoopVersion } from "./bytes-loop-versions.js";
import { emitLlvmModule } from "./emitter.js";

const loc = { file: "versions.ts", start: 0, end: 0 };
const f64s: IrType = { kind: "bytes", elem: "f64" };
const i32s: IrType = { kind: "bytes", elem: "i32" };
const num = (value: number): IrExpr => ({ kind: "numLit", value, type: F64, loc });
const ref = (localId: string, type: IrType = F64): IrExpr => ({
  kind: "varRef",
  localId,
  type,
  loc,
});
const bin = (op: string, left: IrExpr, right: IrExpr): IrExpr =>
  ({ kind: "bin", op, left, right, type: F64, loc }) as IrExpr;
const get = (receiver: IrExpr, index: IrExpr): IrExpr => ({
  kind: "bytesIntrinsic",
  method: "get",
  receiver,
  args: [index],
  invalidNaN: true,
  type: F64,
  loc,
});
const set = (arr: IrExpr, index: IrExpr, value: IrExpr): IrStmt => ({
  kind: "bytesSet",
  arr,
  index,
  value,
  loc,
});
const counted = (
  body: IrStmt[],
  limit: IrExpr = ref("n"),
  counter = "i",
): IrStmt & { kind: "for" } => ({
  kind: "for",
  init: { kind: "varDecl", localId: counter, init: num(0), loc },
  cond: { kind: "bin", op: "<", left: ref(counter), right: limit, type: BOOL, loc },
  update: { kind: "assign", localId: counter, value: bin("+", ref(counter), num(1)), loc },
  body,
  loc,
});
const local = (
  id: string,
  type: IrType,
  mutable = false,
  extra: Partial<IrLocal> = {},
): IrLocal => ({
  id,
  name: id,
  type,
  mutable,
  ...extra,
});

function fn(body: IrStmt[], extra: IrLocal[] = []): IrFunction {
  return {
    name: "kernel",
    params: [
      { localId: "out", name: "out", type: f64s },
      { localId: "src", name: "src", type: f64s },
      { localId: "table", name: "table", type: i32s },
      { localId: "n", name: "n", type: F64 },
      { localId: "k", name: "k", type: F64 },
    ],
    returnType: VOID,
    locals: [
      local("out", f64s),
      local("src", f64s),
      local("table", i32s),
      local("n", F64),
      local("k", F64),
      local("i", F64, true),
      local("j", F64, true),
      ...extra,
    ],
    body,
    loc,
  };
}

function match(
  f: IrFunction,
  loop: IrStmt & { kind: "for" },
  captured: string[] = [],
): BytesLoopVersion | null {
  const ranges = analyzeIntegerRanges(f);
  const locals = new Map(f.locals.map((l) => [l.id, l]));
  return matchBytesLoopVersion(loop, matchIntegerCountedForLoop(loop, locals, ranges), {
    locals,
    invariantGlobals: new Set(),
    captured: new Set(captured),
    ranges,
    initialized: findInitializedByteLoopBindings(f).get(loop) ?? new Set(),
    proven: new Set(),
    workers: false,
    owned: new Set(),
  });
}

test("a counted loop's affine accesses get one guard and exact operand ranges", () => {
  const shifted = bin("+", ref("i"), num(1));
  const loop = counted([set(ref("out", f64s), ref("i"), get(ref("src", f64s), shifted))]);
  const version = match(fn([loop]), loop)!;
  expect(version).not.toBeNull();
  expect(version.bounds.size).toBe(2);
  expect(version.receivers.map((r) => r.ref.kind === "varRef" && r.ref.localId)).toEqual([
    "out",
    "src",
  ]);
  expect(version.affine.map((c) => [c.scale, c.minOffset, c.maxEnd])).toEqual([
    [1, 0, 0],
    [1, 1, 1],
  ]);
  // `n` is unproven: the guard bounds the counter so `i + 1` stays exact.
  expect(version.counted?.limitGuarded).toBe(true);
  expect(version.counterBound).toBe(Number.MAX_SAFE_INTEGER - 1);
  expect(version.ranges.get(shifted)).toEqual({ min: 1, max: Number.MAX_SAFE_INTEGER });
});

test("invariant terms without a range are tested by the guard", () => {
  // for (let i = 0; i < n; i++) out[i] = src[k + i], with `k` a parameter
  const shifted = bin("+", ref("k"), ref("i"));
  const loop = counted([set(ref("out", f64s), ref("i"), get(ref("src", f64s), shifted))]);
  const kernel = fn([loop]);
  const version = match(kernel, loop)!;
  expect([...version.guarded]).toEqual(["v1:k"]);
  expect(version.affine.map((c) => c.terms.map((t) => t.key))).toEqual([[], ["v1:k"]]);
  // In the fast copy the term has the range the guard tests.
  expect(version.ranges.get(shifted.kind === "bin" ? shifted.left : shifted)).toEqual({
    min: -(2 ** 32),
    max: 2 ** 32,
  });
  const mod: IrModule = {
    irVersion: 17,
    sourceFile: loc.file,
    entry: "__main",
    functions: [
      { name: "__main", params: [], returnType: VOID, locals: [], body: [], loc },
      kernel,
    ],
  };
  const body = /^define internal [^\n]*@sc_bf_kernel[^]*?^}/m.exec(emitLlvmModule(mod))![0];
  const guard = body.slice(0, body.search(/^bytes\.version\.(fast|slow)\d+:$/m));
  // -2^32 <= k <= 2^32, and k is the double of its frozen integer.
  expect(guard).toMatch(/fcmp oge double %\S+, 0xC1F0000000000000/);
  expect(guard).toMatch(/fcmp ole double %\S+, 0x41F0000000000000/);
  expect(guard).toMatch(/freeze i64/);
  const fast = /^bytes\.version\.fast\d+:$[^]*?^bytes\.version\.done\d+:$/m.exec(body)![0];
  expect(fast).not.toContain("bytes.index");
  expect(body.slice(0, body.indexOf(fast))).toContain("bytes.index.invalid");
});

test("statically ranged indices compare one constant with the length", () => {
  const masked = bin("&", bin("^", ref("i"), ref("k")), num(255));
  const loop = counted([set(ref("out", f64s), num(0), get(ref("table", i32s), masked))]);
  const version = match(fn([loop]), loop)!;
  expect(version.fixed.map((c) => [version.receivers[c.receiver]!.ref, c.end])).toEqual([
    [ref("out", f64s), 0],
    [ref("table", i32s), 255],
  ]);
  expect(version.affine).toEqual([]);
  expect(version.counted).toBeNull();
});

test("scaled counters and body temps resolve to their receiver and index", () => {
  const temps = [local("view", f64s), local("at", F64)];
  const at = bin("+", bin("*", ref("i"), num(4)), num(3));
  const loop = counted([
    { kind: "varDecl", localId: "view", init: ref("src", f64s), loc },
    { kind: "varDecl", localId: "at", init: at, loc },
    set(ref("view", f64s), ref("at"), num(1)),
    // (The integer counted loop needs one direct counter index.)
    set(ref("out", f64s), ref("i"), num(0)),
  ]);
  const version = match(fn([loop], temps), loop)!;
  expect(version.receivers.map((r) => r.ref)).toEqual([ref("src", f64s), ref("out", f64s)]);
  expect(version.affine.map((c) => [c.scale, c.minOffset, c.maxEnd])).toEqual([
    [4, 3, 3],
    [1, 0, 0],
  ]);
  expect(version.ranges.has(at)).toBe(true);
});

test("negative factors, rebinding, captures and outer loops are not versioned", () => {
  // `i * -1` is -0 at zero, so it is not treated as an affine operand.
  const negative = counted([set(ref("out", f64s), bin("*", ref("i"), num(-1)), num(1))]);
  expect(match(fn([negative]), negative)).toBeNull();
  const rebound = counted([
    set(ref("out", f64s), ref("i"), num(1)),
    { kind: "assign", localId: "out", value: ref("src", f64s), loc },
  ]);
  expect(match(fn([rebound]), rebound)).toBeNull();
  const plain = counted([set(ref("out", f64s), ref("i"), num(1))]);
  expect(match(fn([plain]), plain, ["out"])).toBeNull();
  const inner = counted([set(ref("out", f64s), ref("j"), num(1))], ref("n"), "j");
  const outer = counted([inner]);
  expect(match(fn([outer]), outer)).toBeNull();
  expect(match(fn([outer]), inner)).not.toBeNull();
});

test("emitted loops version the body and tag typed-array memory", () => {
  const loop = counted([
    set(ref("out", f64s), ref("i"), bin("*", get(ref("src", f64s), ref("i")), num(2))),
  ]);
  const kernel = fn([loop]);
  const mod: IrModule = {
    irVersion: 17,
    sourceFile: loc.file,
    entry: "__main",
    functions: [
      { name: "__main", params: [], returnType: VOID, locals: [], body: [], loc },
      kernel,
    ],
  };
  const llvm = emitLlvmModule(mod);
  const body = /^define internal [^\n]*@sc_bf_kernel[^]*?^}/m.exec(llvm)![0];
  expect(body).toContain("bytes.version.fast");
  expect(body).toContain("bytes.version.slow");
  // The checked copy keeps its per-element tests; the guard reads lengths.
  expect(body).toContain("bytes.index.invalid");
  expect(body).toMatch(/store double [^\n]*, align 1, !tbaa !\d+/);
  expect(body).toMatch(/load double, ptr [^\n]*, align 1, !tbaa !\d+/);
  expect(body).toMatch(/load i64, ptr [^\n]*, !tbaa !\d+/);
  expect(body).toMatch(/load ptr, ptr [^\n]*, !tbaa !\d+/);
  const elements = /store double [^\n]*!tbaa !(\d+)/.exec(body)![1];
  const header = /load ptr, ptr [^\n]*!tbaa !(\d+)/.exec(body)![1];
  expect(elements).not.toBe(header);
});

test("loops to a typed array's length version the other typed arrays they index", () => {
  const length = (receiver: IrExpr): IrExpr => ({
    kind: "bytesIntrinsic",
    method: "length",
    receiver,
    args: [],
    type: F64,
    loc,
  });
  const emit = (body: IrStmt[]): string => {
    const mod: IrModule = {
      irVersion: 17,
      sourceFile: loc.file,
      entry: "__main",
      functions: [
        { name: "__main", params: [], returnType: VOID, locals: [], body: [], loc },
        fn(body),
      ],
    };
    return /^define internal [^\n]*@sc_bf_kernel[^]*?^}/m.exec(emitLlvmModule(mod))![0];
  };
  // for (let i = 0; i < out.length; i++) out[i] = src[i] * 2
  const scaled = set(ref("out", f64s), ref("i"), bin("*", get(ref("src", f64s), ref("i")), num(2)));
  const body = emit([counted([scaled], length(ref("out", f64s)))]);
  const fast = /^bytes\.version\.fast\d+:$[^]*?^bytes\.version\.done\d+:$/m.exec(body)![0];
  // The loop keeps its integer induction, and the fast copy reads `src`
  // unchecked.
  expect(body).toContain("integer induction i");
  expect(fast).not.toContain("bytes.index");
  expect(body.slice(0, body.indexOf(fast))).toContain("bytes.index.invalid");
  // A body that rebinds `src` keeps one checked loop.
  const rebound = emit([
    counted(
      [scaled, { kind: "assign", localId: "src", value: ref("out", f64s), loc }],
      length(ref("out", f64s)),
    ),
  ]);
  expect(rebound).not.toContain("bytes.version.fast");
  expect(rebound).toContain("bytes.index.invalid");
});

test("worker programs test each receiver's shared storage once in the guard", () => {
  // for (let i = 0; i < n; i++) out[i] = src[i] * 2, where either view may
  // be shared.
  const loop = counted([
    set(ref("out", f64s), ref("i"), bin("*", get(ref("src", f64s), ref("i")), num(2))),
  ]);
  const kernel = fn([loop]);
  const mod: IrModule = {
    irVersion: 17,
    sourceFile: loc.file,
    entry: "__main",
    workers: true,
    functions: [
      { name: "__main", params: [], returnType: VOID, locals: [], body: [], loc },
      kernel,
    ],
  };
  const body = /^define internal [^\n]*@sc_bf_kernel[^]*?^}/m.exec(emitLlvmModule(mod))![0];
  const guard = body.slice(0, body.search(/^bytes\.version\.(fast|slow)\d+:$/m));
  expect(guard.match(/icmp eq ptr %\S+, null/g)).toHaveLength(2);
  const fast = /^bytes\.version\.fast\d+:$[^]*?^bytes\.version\.done\d+:$/m.exec(body)![0];
  expect(fast).not.toContain("bytes.shared");
  expect(fast).not.toMatch(/(load|store) atomic double/);
  // The checked copy keeps the shared-memory path for each access.
  const slow = body.slice(body.search(/^bytes\.version\.slow\d+:$/m), body.indexOf(fast));
  expect(slow).toContain("load atomic double");
  expect(slow).toContain("store atomic double");
});

test("index temps of a version's counter are integers in the fast copy", () => {
  // for (let i = 0; i < out.length; i++) { const j = i * 4; out[i] = src[j] + src[j + 1] }
  const length: IrExpr = {
    kind: "bytesIntrinsic",
    method: "length",
    receiver: ref("out", f64s),
    args: [],
    type: F64,
    loc,
  };
  const loop = counted(
    [
      { kind: "varDecl", localId: "at", init: bin("*", ref("i"), num(4)), loc },
      set(
        ref("out", f64s),
        ref("i"),
        bin(
          "+",
          get(ref("src", f64s), ref("at")),
          get(ref("src", f64s), bin("+", ref("at"), num(1))),
        ),
      ),
    ],
    length,
  );
  const mod: IrModule = {
    irVersion: 17,
    sourceFile: loc.file,
    entry: "__main",
    functions: [
      { name: "__main", params: [], returnType: VOID, locals: [], body: [], loc },
      fn([loop], [local("at", F64)]),
    ],
  };
  const body = /^define internal [^\n]*@sc_bf_kernel[^]*?^}/m.exec(emitLlvmModule(mod))![0];
  const fast = /^bytes\.version\.fast\d+:$[^]*?^bytes\.version\.done\d+:$/m.exec(body)![0];
  expect(body).toContain("alloca i64 ; integer at");
  expect(fast).toMatch(/mul nsw i64 %\S+, 4/);
  expect(fast).toMatch(/add nsw i64 %\S+, 1/);
  expect(fast).not.toContain("fmul");
  expect(fast).not.toContain("fptosi");
  expect(fast).not.toContain("bytes.index");
});

test("Float16Array accesses version in elements and share the element tag", () => {
  const f16s: IrType = { kind: "bytes", elem: "f16" };
  const withHalves = (body: IrStmt[]): IrFunction => {
    const f = fn(body, [local("half", f16s)]);
    return { ...f, params: [...f.params, { localId: "half", name: "half", type: f16s }] };
  };
  // half[i] = src[i + 1]; out[i] = half[i] * 2
  const loop = counted([
    set(ref("half", f16s), ref("i"), get(ref("src", f64s), bin("+", ref("i"), num(1)))),
    set(ref("out", f64s), ref("i"), bin("*", get(ref("half", f16s), ref("i")), num(2))),
  ]);
  const kernel = withHalves([loop]);
  const version = match(kernel, loop)!;
  expect(version.bounds.size).toBe(4);
  expect(version.receivers.map((r) => r.ref)).toEqual([
    ref("half", f16s),
    ref("src", f64s),
    ref("out", f64s),
  ]);
  // Element offsets against the element count, whatever the element size.
  expect(version.affine.map((c) => [c.scale, c.minOffset, c.maxEnd])).toEqual([
    [1, 0, 0],
    [1, 1, 1],
    [1, 0, 0],
  ]);

  const mod: IrModule = {
    irVersion: 17,
    sourceFile: loc.file,
    entry: "__main",
    functions: [
      { name: "__main", params: [], returnType: VOID, locals: [], body: [], loc },
      kernel,
    ],
  };
  const body = /^define internal [^\n]*@sc_bf_kernel[^]*?^}/m.exec(emitLlvmModule(mod))![0];
  const fast = /^bytes\.version\.fast\d+:$[^]*?^bytes\.version\.done\d+:$/m.exec(body)![0];
  expect(fast).toContain("call double @scr_f16_to_f64");
  expect(fast).toContain("call zeroext i16 @scr_f16_from_f64");
  expect(fast).not.toContain("bytes.index");
  const halfStore = /store i16 [^\n]*, align 1, !tbaa !(\d+)/.exec(fast)![1];
  const halfLoad = /load i16, ptr [^\n]*, align 1, !tbaa !(\d+)/.exec(fast)![1];
  const doubleStore = /store double [^\n]*, align 1, !tbaa !(\d+)/.exec(fast)![1];
  // Views of any element type may share a buffer: one element category.
  expect(halfStore).toBe(doubleStore);
  expect(halfLoad).toBe(doubleStore);
  // The checked copy keeps its per-element tests.
  expect(body.slice(0, body.indexOf(fast))).toContain("bytes.index.invalid");
});

test("bodies compiled without optimization keep one checked loop", () => {
  const loop = counted([set(ref("out", f64s), ref("i"), get(ref("src", f64s), ref("i")))]);
  const boxes = Array.from({ length: 512 }, (_, k) => local(`box${k}`, F64, true, { boxed: true }));
  const mod: IrModule = {
    irVersion: 17,
    sourceFile: loc.file,
    entry: "__main",
    functions: [
      { name: "__main", params: [], returnType: VOID, locals: [], body: [], loc },
      fn([loop], boxes),
    ],
  };
  const body = /^define internal [^\n]*@sc_bf_kernel[^]*?^}/m.exec(emitLlvmModule(mod))![0];
  expect(body.split("\n", 1)[0]).toContain("optnone");
  expect(body).not.toContain("bytes.version");
  expect(body).toContain("bytes.index.invalid");
});
