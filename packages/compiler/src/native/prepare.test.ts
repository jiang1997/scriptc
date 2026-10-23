import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { nativeCodegenTarget } from "../backend/targets.js";
import { runFrontend, type FrontendFactory } from "../frontend/pipeline.js";
import { loadProgram } from "../frontend/program-node.js";
import { ts7Executable } from "../frontend/ts7/rpc-api.js";
import { deserializeModule } from "../ir/serialize.js";
import { NativeCache } from "./cache.js";
import { prepareNativeExecutable } from "./prepare.js";
import type { NativeToolchain } from "./toolchain.js";

/** A prepared input with its LLVM parts joined: a cache hit reads the text
 * back as one part. */
function text(input: ReturnType<ReturnType<typeof fixture>["prepare"]>) {
  return input.ok ? { ...input, llvm: input.llvm.join("") } : input;
}

const scratch: string[] = [];
afterEach(() => {
  for (const path of scratch.splice(0)) rmSync(path, { recursive: true, force: true });
});

function fixtureToolchain(): NativeToolchain {
  const target = nativeCodegenTarget()!;
  return {
    compilerVersion: "test",
    target,
    helper: target.helper,
    helperExecutable: "unused",
    helperPackageRoot: "unused",
    runtimePackRoot: "unused",
    linker: "unused",
    linkerArgs: [],
    dsymutil: "unused",
    ts7Executable: ts7Executable(),
  };
}

function fixture() {
  const temporary = mkdtempSync(join(tmpdir(), "scriptc-native-frontend-"));
  scratch.push(temporary);
  const root = join(temporary, "project");
  mkdirSync(root);
  const entry = join(root, "main.ts");
  const dependency = join(root, "value.ts");
  writeFileSync(entry, 'import { value } from "./value.js"; console.log(value);\n');
  writeFileSync(dependency, 'export const value = "first";\n');
  writeFileSync(
    join(root, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: { strict: true, types: [], target: "esnext", module: "nodenext" },
    }),
  );
  writeFileSync(join(root, "package.json"), '{"type":"module"}');
  const toolchain = fixtureToolchain();
  const cache = new NativeCache(join(temporary, "cache"));
  const options = {
    outPath: join(root, ".scriptc", "main"),
    outDir: join(root, ".scriptc"),
    optimization: "release" as const,
  };
  let loads = 0;
  const frontend: FrontendFactory = (path, npmStatic, externalTypes) => {
    loads++;
    return runFrontend(path, loadProgram, npmStatic, externalTypes);
  };
  const prepare = (extra: { emitIr?: boolean } = {}) =>
    prepareNativeExecutable(entry, { ...options, ...extra }, null, toolchain, frontend, cache);
  return { root, entry, dependency, cache, options, prepare, loads: () => loads };
}

test("warm frontend reuse survives output creation and invalidates imported source edits", () => {
  const f = fixture();
  const first = f.prepare();
  expect(first.ok, JSON.stringify(first)).toBe(true);
  if (!first.ok) return;
  mkdirSync(f.options.outDir);
  writeFileSync(f.options.outPath, "binary placeholder");
  writeFileSync(join(f.options.outDir, "main.ll"), first.llvm.join(""));
  const warm = f.prepare();
  expect(text(warm)).toEqual(text(first));
  expect(f.loads()).toBe(1);
  writeFileSync(f.dependency, 'export const value = "second";\n');
  const edited = f.prepare();
  expect(edited.ok).toBe(true);
  if (edited.ok) expect(edited.llvm.join("")).not.toBe(first.llvm.join(""));
  expect(f.loads()).toBe(2);
});

test("comment and whitespace edits reuse the frontend output a fresh build reproduces", () => {
  const f = fixture();
  const first = f.prepare();
  expect(first.ok, JSON.stringify(first)).toBe(true);
  if (!first.ok) return;
  const commented = '// The exported value.\nexport const value = /* unchanged */ "first";\n';
  writeFileSync(f.dependency, commented);
  const reused = f.prepare();
  expect(f.loads()).toBe(1);
  expect(reused.ok).toBe(true);
  if (!reused.ok) return;
  expect(reused.llvm.join("")).toBe(first.llvm.join(""));
  expect(new Map(reused.sources).get(f.dependency)).toBe(commented);
  // The reused output is the one the edited sources lower to.
  const fresh = prepareNativeExecutable(
    f.entry,
    f.options,
    null,
    fixtureToolchain(),
    (path, npmStatic, externalTypes) => runFrontend(path, loadProgram, npmStatic, externalTypes),
    new NativeCache(join(f.root, "fresh-cache")),
  );
  expect(fresh.ok && fresh.llvm.join("")).toBe(first.llvm.join(""));
  // The refreshed entry still notices a later code edit.
  writeFileSync(f.dependency, 'export const value = "second";\n');
  const edited = f.prepare();
  expect(f.loads()).toBe(2);
  expect(edited.ok && edited.llvm.join("")).not.toBe(first.llvm.join(""));
});

test("a comment edit inside source text the output carries is rebuilt", () => {
  const f = fixture();
  // A failing assert(value) reports its call's source text.
  const source = (call: string) =>
    `import assert from "node:assert";\nexport const value = "first";\n${call};\n`;
  writeFileSync(f.dependency, source("assert(value.length > 0)"));
  const first = f.prepare();
  expect(first.ok, JSON.stringify(first)).toBe(true);
  if (!first.ok) return;
  writeFileSync(f.dependency, source("assert(value.length > 0 /* checked */)"));
  const edited = f.prepare();
  expect(f.loads()).toBe(2);
  expect(edited.ok && edited.llvm.join("")).not.toBe(first.llvm.join(""));
});

test("a whitespace edit that moves a reported source line is rebuilt", () => {
  const f = fixture();
  // node:test reports the file, line and column of each test.
  const source = (gap: string) =>
    `import { test } from "node:test";\nexport const value = "first";\n${gap}test("value", () => {});\n`;
  writeFileSync(f.dependency, source(""));
  const first = f.prepare();
  expect(first.ok, JSON.stringify(first)).toBe(true);
  if (!first.ok) return;
  writeFileSync(f.dependency, source("\n"));
  const edited = f.prepare();
  expect(f.loads()).toBe(2);
  expect(edited.ok && edited.llvm.join("")).not.toBe(first.llvm.join(""));
});

test("structurally invalid cached features cause a rebuild even with a valid digest", () => {
  const f = fixture();
  expect(f.prepare().ok).toBe(true);
  const family = join(f.cache.root, "frontend");
  const key = readdirSync(family).find((name) => /^[0-9a-f]{64}$/.test(name))!;
  const payload = JSON.parse(readFileSync(join(family, key), "utf8"));
  payload.input.features = {};
  f.cache.write("frontend", key, JSON.stringify(payload));
  expect(f.prepare().ok).toBe(true);
  expect(f.loads()).toBe(2);
});

test("serialized IR travels as bounded parts through the frontend cache", () => {
  const f = fixture();
  const first = f.prepare({ emitIr: true });
  expect(first.ok, JSON.stringify(first)).toBe(true);
  if (!first.ok) return;
  expect(Array.isArray(first.ir)).toBe(true);
  const mod = deserializeModule(first.ir!.join(""));
  expect(mod.functions.length).toBeGreaterThan(0);
  const warm = f.prepare({ emitIr: true });
  expect(f.loads()).toBe(1);
  expect(text(warm)).toEqual(text(first));
  const family = join(f.cache.root, "frontend");
  const key = readdirSync(family).find((name) => /^[0-9a-f]{64}$/.test(name))!;
  const payload = JSON.parse(readFileSync(join(family, key), "utf8"));
  expect(payload.schema).toBe("scriptc.native-frontend.v3");
  expect(payload.input.llvm).toBe("");
  expect(payload.input.ir).toBeNull();
  expect(payload.llvm).toBe(first.llvm.join(""));
  expect(payload.ir).toEqual(first.ir);
});
