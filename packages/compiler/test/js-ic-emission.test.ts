import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile, deserializeModule, validateModule } from "../src/index.js";
import { emitLlvmModule } from "../src/backend/llvm/emitter.js";
import { moduleUsesDynTier } from "../src/ir/runtime-features.js";

/** The LLVM body of a function by source name. */
function body(llvm: string, name: string): string {
  const match = llvm.match(
    new RegExp(
      `define internal [^\\n]+ @sc_(?:b)?f_${name}(?:\\.i32)?\\([^\\n]*\\) #0 \\{([\\s\\S]*?)\\n\\}`,
    ),
  );
  expect(match, `${name} LLVM function`).not.toBeNull();
  return match![1]!;
}

test("dynamic-tier property sites read and write through inline caches", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-js-ic-"));
  try {
    const entry = join(dir, "main.js");
    const outPath = join(dir, "main.ir.json");
    await writeFile(
      entry,
      `
function dyn(v) { return v; }
function read(o) { return o.x; }
function write(o, v) { o.x = v; }
function bump(o) { o.n += 1; }
function at(a, i) { return a[i]; }
function call(o) { return o.m(); }
var o = dyn({ x: 1, n: 0, m: function () { return 2; } });
write(o, 3);
bump(o);
console.log(read(o), at(dyn([5, 6]), 1), call(o), o.n);
`,
    );
    const result = await compile(entry, { outDir: dir, outPath, outputKind: "ir" });
    if (!result.ok)
      throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
    const mod = deserializeModule(await readFile(outPath, "utf8"));
    expect(validateModule(mod)).toEqual([]);
    expect(moduleUsesDynTier(mod)).toBe(true);
    const llvm = emitLlvmModule(mod);
    // Each site owns a zeroed thread-local cache record.
    expect(llvm).toMatch(
      /@sc_js_ic_0 = internal (thread_local )?global \[21 x i64\] zeroinitializer/,
    );
    expect(body(llvm, "read")).toContain("@scr_js_load_probe(");
    expect(body(llvm, "write")).toContain("@scr_js_store_probe(");
    expect(body(llvm, "at")).toContain("@scr_js_keyed_probe(");
    expect(body(llvm, "call")).toContain("@scr_js_load_probe(");
    // A compound assignment stores its number result from the jsval: an
    // unshared number cell is updated in place.
    expect(body(llvm, "bump")).toMatch(/store double %t\d+, ptr %t\d+/);
    // The helper stays the out-of-line slow path of every site.
    expect(body(llvm, "read")).toMatch(
      /@sc_bf__x25_dyn_class_property_\d+\(ptr %t\d+\) noinline cold/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("typed programs have no cache sites and keep the ordinary runtime", async () => {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-js-ic-typed-"));
  try {
    const entry = join(dir, "main.ts");
    const outPath = join(dir, "main.ir.json");
    await writeFile(
      entry,
      `
interface P { x: number; y: number }
function len2(p: P): number { return p.x * p.x + p.y * p.y; }
const parsed: unknown = JSON.parse('{"x":3,"y":4}');
console.log(len2({ x: 3, y: 4 }), typeof parsed);
`,
    );
    const result = await compile(entry, { outDir: dir, outPath, outputKind: "ir" });
    if (!result.ok)
      throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
    const mod = deserializeModule(await readFile(outPath, "utf8"));
    expect(moduleUsesDynTier(mod)).toBe(false);
    const llvm = emitLlvmModule(mod);
    expect(llvm).not.toContain("@sc_js_ic_");
    expect(llvm).not.toContain("@scr_js_");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
