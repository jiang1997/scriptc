import { expect, test } from "vitest";
import { F64, type IrExpr, type IrFunction, type IrStmt, type IrType } from "../../ir/ir.js";
import { observeRecordLiteralRebuilds, transformExpr } from "../../ir/traverse.js";
import { ShapeRegistry } from "../type-mapper.js";
import {
  applyKeyOrderWitnesses,
  KeyOrderNotes,
  type KeyOrderSegment,
} from "./key-order-witness.js";
import type { Lowerer } from "./lowerer.js";

const loc = { file: "order.ts", start: 0, end: 1 };
/** `number | undefined`: the optional-field slot type. */
const OPT: IrType = { kind: "union", unionId: "u0" };
const num = (value: number): IrExpr => ({ kind: "numLit", value, type: F64, loc });
const absent: IrExpr = { kind: "fieldAbsent", unionId: "u0", type: OPT, loc };

interface Fixture {
  lowerer: Lowerer;
  shapes: ShapeRegistry;
  notes: KeyOrderNotes;
  record(fields: [string, IrType][], order: string[]): IrType & { kind: "record" };
  literal(type: IrType, keys: string[], segments?: KeyOrderSegment[]): IrExpr;
  run(body: IrStmt[]): void;
  order(type: IrType & { kind: "record" }): string[] | undefined;
}

function fixture(): Fixture {
  const shapes = new ShapeRegistry();
  const notes = new KeyOrderNotes();
  const lowerer = {
    shapes,
    keyOrder: notes,
    unions: new Map([["u0", { id: "u0", arms: [F64, { kind: "undefinedT" }] }]]),
    classes: new Map(),
    armTag: (unionId: string, arm: IrType): number =>
      unionId === "u0" && arm.kind === "undefinedT" ? 1 : -1,
  } as unknown as Lowerer;
  const record = (fields: [string, IrType][], order: string[]): IrType & { kind: "record" } => ({
    kind: "record",
    shapeId: shapes.intern(
      [...fields].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([name, type]) => ({ name, type })),
      false,
      undefined,
      order,
    ),
  });
  const literal = (type: IrType, keys: string[], segments?: KeyOrderSegment[]): IrExpr => {
    const shape = shapes.get((type as IrType & { kind: "record" }).shapeId)!;
    const fields = keys.map((name) => ({ name, value: num(1) }));
    for (const f of shape.fields)
      if (!keys.includes(f.name)) fields.push({ name: f.name, value: absent });
    return notes.literal(
      { kind: "recordLit", fields, type, loc },
      segments ?? keys.map((name) => ({ kind: "key", name, definite: true })),
    );
  };
  const run = (body: IrStmt[]): void => {
    const fn: IrFunction = { name: "main", params: [], returnType: F64, locals: [], body, loc };
    applyKeyOrderWitnesses(lowerer, [fn]);
  };
  const order = (type: IrType & { kind: "record" }): string[] | undefined =>
    shapes.get(type.shapeId)?.declaredOrder;
  return { lowerer, shapes, notes, record, literal, run, order };
}

const observe = (value: IrExpr): IrStmt => ({
  kind: "exprStmt",
  expr: { kind: "jsonStringify", value, type: { kind: "string" }, loc },
  loc,
});
const decl = (localId: string, init: IrExpr): IrStmt => ({ kind: "varDecl", localId, init, loc });
const ref = (localId: string, type: IrType): IrExpr => ({ kind: "varRef", localId, type, loc });
const set = (obj: IrExpr, field: string): IrStmt => ({
  kind: "recordSet",
  obj,
  shapeId: (obj.type as IrType & { kind: "record" }).shapeId,
  field,
  value: num(2),
  loc,
});

test("a shape takes the one order its literals write", () => {
  const f = fixture();
  const ab = f.record(
    [
      ["a", F64],
      ["b", F64],
    ],
    ["a", "b"],
  );
  f.run([observe(f.literal(ab, ["b", "a"])), observe(f.literal(ab, ["b", "a"]))]);
  expect(f.order(ab)).toEqual(["b", "a"]);
  expect(f.notes.changed.has(ab.shapeId)).toBe(true);
});

test("literals that agree with the table leave the same array in place", () => {
  const f = fixture();
  const ab = f.record(
    [
      ["a", F64],
      ["b", F64],
    ],
    ["a", "b"],
  );
  const before = f.order(ab);
  f.run([observe(f.literal(ab, ["a", "b"]))]);
  expect(f.order(ab)).toBe(before);
  expect(f.notes.changed.size).toBe(0);
});

test("values built in two orders keep today's table", () => {
  const f = fixture();
  const ab = f.record(
    [
      ["a", F64],
      ["b", F64],
    ],
    ["a", "b"],
  );
  f.run([observe(f.literal(ab, ["b", "a"])), observe(f.literal(ab, ["a", "b"]))]);
  expect(f.order(ab)).toEqual(["a", "b"]);
});

test("an unobserved shape keeps today's table", () => {
  const f = fixture();
  const ab = f.record(
    [
      ["a", F64],
      ["b", F64],
    ],
    ["a", "b"],
  );
  f.run([decl("x", f.literal(ab, ["b", "a"]))]);
  expect(f.order(ab)).toEqual(["a", "b"]);
});

test("a synthesized construction pins today's table", () => {
  const f = fixture();
  const ab = f.record(
    [
      ["a", F64],
      ["b", F64],
    ],
    ["a", "b"],
  );
  const synthesized: IrExpr = {
    kind: "recordLit",
    fields: [
      { name: "a", value: num(1) },
      { name: "b", value: num(2) },
    ],
    type: ab,
    loc,
  };
  f.run([observe(f.literal(ab, ["b", "a"])), observe(synthesized)]);
  expect(f.order(ab)).toEqual(["a", "b"]);
});

test("a checked conversion alone pins today's table", () => {
  const f = fixture();
  const ab = f.record(
    [
      ["a", OPT],
      ["b", F64],
    ],
    ["a", "b"],
  );
  const parsed: IrExpr = { kind: "dynCheck", value: ref("j", { kind: "dyn" }), type: ab, loc };
  // A late write to `a` would move it after `b`; values only a checked
  // conversion builds keep today's table, so parsed values in that order
  // need no source view.
  f.run([decl("p", parsed), set(ref("p", ab), "a"), observe(ref("p", ab))]);
  expect(f.order(ab)).toEqual(["a", "b"]);
});

test("a shape literals and a checked conversion both build takes the literals' order", () => {
  const f = fixture();
  const ab = f.record(
    [
      ["a", F64],
      ["b", F64],
    ],
    ["a", "b"],
  );
  const parsed: IrExpr = { kind: "dynCheck", value: ref("j", { kind: "dyn" }), type: ab, loc };
  // The literal's values can enumerate in no other order; parsed values in
  // another order keep a record-source view.
  f.run([observe(f.literal(ab, ["b", "a"])), observe(parsed)]);
  expect(f.order(ab)).toEqual(["b", "a"]);
});

test("a literal an IR rewrite rebuilds keeps its witness", () => {
  const f = fixture();
  const ab = f.record(
    [
      ["a", F64],
      ["b", F64],
    ],
    ["a", "b"],
  );
  const identity = { expr: (e: IrExpr): IrExpr => e, stmt: (st: IrStmt): IrStmt => st };
  const original = f.literal(ab, ["b", "a"]);
  observeRecordLiteralRebuilds((from, to) => f.notes.follow(from, to));
  let rebuilt: IrExpr;
  try {
    rebuilt = transformExpr(original, identity);
  } finally {
    observeRecordLiteralRebuilds(null);
  }
  expect(rebuilt).not.toBe(original);
  f.run([observe(rebuilt)]);
  expect(f.order(ab)).toEqual(["b", "a"]);
});

test("a spread contributes its source's order, and an override keeps its position", () => {
  const f = fixture();
  const src = f.record(
    [
      ["a", F64],
      ["b", F64],
    ],
    ["a", "b"],
  );
  const out = f.record(
    [
      ["a", F64],
      ["b", F64],
      ["c", F64],
    ],
    ["a", "b", "c"],
  );
  const spread: KeyOrderSegment = { kind: "spread", shapeId: src.shapeId, maybeAbsent: false };
  f.run([
    decl("s", f.literal(src, ["b", "a"])),
    // { ...s, a: 1, c: 2 } — `a` stays where the spread put it.
    observe(
      f.literal(
        out,
        ["a", "b", "c"],
        [
          spread,
          { kind: "key", name: "a", definite: true },
          { kind: "key", name: "c", definite: true },
        ],
      ),
    ),
  ]);
  expect(f.order(out)).toEqual(["b", "a", "c"]);
});

test("a spread of a checked-conversion source cannot be ordered statically", () => {
  const f = fixture();
  const src = f.record(
    [
      ["a", F64],
      ["b", F64],
    ],
    ["a", "b"],
  );
  const out = f.record(
    [
      ["a", F64],
      ["b", F64],
      ["c", F64],
    ],
    ["c", "a", "b"],
  );
  const parsed: IrExpr = { kind: "dynCheck", value: ref("j", { kind: "dyn" }), type: src, loc };
  const spread: KeyOrderSegment = { kind: "spread", shapeId: src.shapeId, maybeAbsent: false };
  f.run([
    decl("s", parsed),
    observe(f.literal(out, ["a", "b", "c"], [spread, { kind: "key", name: "c", definite: true }])),
  ]);
  expect(f.order(out)).toEqual(["c", "a", "b"]);
});

test("a late-only optional key follows the keys values are built with", () => {
  const f = fixture();
  const o = f.record(
    [
      ["a", OPT],
      ["b", F64],
    ],
    ["a", "b"],
  );
  f.run([decl("o", f.literal(o, ["b"])), set(ref("o", o), "a"), observe(ref("o", o))]);
  expect(f.order(o)).toEqual(["b", "a"]);
});

test("straight-line writes of late-only keys keep program order", () => {
  const f = fixture();
  const o = f.record(
    [
      ["id", F64],
      ["x", OPT],
      ["y", OPT],
    ],
    ["id", "x", "y"],
  );
  f.run([
    decl("o", f.literal(o, ["id"])),
    set(ref("o", o), "y"),
    set(ref("o", o), "x"),
    observe(ref("o", o)),
  ]);
  expect(f.order(o)).toEqual(["id", "y", "x"]);
});

test("late-only keys written through different bindings keep today's table", () => {
  const f = fixture();
  const o = f.record(
    [
      ["id", F64],
      ["x", OPT],
      ["y", OPT],
    ],
    ["id", "x", "y"],
  );
  f.run([
    decl("o", f.literal(o, ["id"])),
    set(ref("o", o), "y"),
    set(ref("p", o), "x"),
    observe(ref("o", o)),
  ]);
  expect(f.order(o)).toEqual(["id", "x", "y"]);
});

test("a late-only key written in a loop over an outer binding keeps today's table", () => {
  const f = fixture();
  const o = f.record(
    [
      ["id", F64],
      ["x", OPT],
      ["y", OPT],
    ],
    ["id", "x", "y"],
  );
  f.run([
    decl("o", f.literal(o, ["id"])),
    set(ref("o", o), "y"),
    {
      kind: "while",
      cond: { kind: "boolLit", value: false, type: { kind: "bool" }, loc },
      body: [set(ref("o", o), "x")],
      loc,
    },
    observe(ref("o", o)),
  ]);
  expect(f.order(o)).toEqual(["id", "x", "y"]);
});

test("re-adding a key a literal creates earlier keeps today's table", () => {
  const f = fixture();
  const o = f.record(
    [
      ["a", OPT],
      ["b", F64],
    ],
    ["a", "b"],
  );
  const del: IrStmt = {
    kind: "recordSet",
    obj: ref("o", o),
    shapeId: o.shapeId,
    field: "a",
    value: absent,
    loc,
  };
  f.run([decl("o", f.literal(o, ["a", "b"])), del, set(ref("o", o), "a"), observe(ref("o", o))]);
  expect(f.order(o)).toEqual(["a", "b"]);
});
