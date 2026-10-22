/* Stream chunk kinds Node cannot oracle — scriptc-only.
 *
 * A typed read() answers `Buffer | null`. When the read itself makes the
 * stream hold strings (the first string a lazy Readable.from pull over a
 * dynamic array produces, or setEncoding() inside _read), Node returns
 * the string, which the typed result cannot hold, so the read throws the
 * encoding fence instead (caught here, so the program exits normally).
 * These pins keep that refusal exact and, under
 * SCRIPTC_SAN=1 (ASan and the RC audit, like every harness lane), prove
 * no string reaches Buffer code. The Node-observable cases are corpus
 * programs (stream-dynamic-entry-kinds.*).
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, test } from "vitest";
import { compile } from "@scriptc/compiler";

const execFileAsync = promisify(execFile);
const repoRoot = join(import.meta.dirname, "../..");
const cacheDir = join(repoRoot, "node_modules/.cache/scriptc-tests");
const sanitize = process.env["SCRIPTC_SAN"] === "1";

interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

async function compileAndRun(name: string, source: string, ext = "ts"): Promise<RunResult> {
  const key = createHash("sha256")
    .update(source)
    .update(sanitize ? "san" : "plain")
    .digest("hex")
    .slice(0, 16);
  const outDir = join(cacheDir, `stream-kinds-${key}`);
  mkdirSync(outDir, { recursive: true });
  const file = join(outDir, `${name}.${ext}`);
  writeFileSync(file, source);
  const result = await compile(file, {
    outPath: join(outDir, name),
    outDir,
    sanitize,
    backend: "llvm",
  });
  if (!result.ok) {
    throw new Error(
      "stream program failed to compile:\n" +
        result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"),
    );
  }
  try {
    const { stdout, stderr } = await execFileAsync(result.binaryPath, [], { encoding: "utf8" });
    return { stdout, stderr: stripAsanFiberWarning(stderr), exitCode: 0 };
  } catch (err) {
    const e = err as { code?: unknown; stdout?: string; stderr?: string };
    if (typeof e.code !== "number") throw err;
    return {
      stdout: e.stdout ?? "",
      stderr: stripAsanFiberWarning(e.stderr ?? ""),
      exitCode: e.code,
    };
  }
}

/** Linux ASan's once-per-process swapcontext warning (see errors.test.ts). */
function stripAsanFiberWarning(s: string): string {
  return s.replace(
    /^==\d+==WARNING: ASan doesn't fully support makecontext\/swapcontext.*\n/gm,
    "",
  );
}

const READ_FENCE_MESSAGE =
  "read() on a stream with an encoding set is not supported yet (consume 'data' events, which deliver strings)";

describe(`typed stream reads of string chunks (scriptc-only${sanitize ? ", sanitized" : ""})`, () => {
  test("a typed read() whose lazy pull yields the first string throws the encoding fence", async () => {
    const r = await compileAndRun(
      "typed-read-json-string",
      `import { Readable } from "node:stream";
const r = Readable.from(JSON.parse('["j1", "j2"]'));
try {
  const chunk = r.read();
  console.log("hex", chunk === null ? "null" : chunk.toString("hex"));
} catch (err) {
  console.log("caught", (err as Error).message);
}
`,
    );
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe(`caught ${READ_FENCE_MESSAGE}\n`);
  });

  test("a typed read() whose _read calls setEncoding() throws the encoding fence", async () => {
    const r = await compileAndRun(
      "typed-read-encoding-in-read",
      `import { Readable } from "node:stream";
const r = new Readable({
  read() {
    this.setEncoding("utf8");
    this.push(Buffer.from("ab"));
    this.push(null);
  },
});
try {
  const chunk = r.read();
  console.log("hex", chunk === null ? "null" : chunk.toString("hex"));
} catch (err) {
  console.log("caught", (err as Error).message);
}
`,
    );
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe(`caught ${READ_FENCE_MESSAGE}\n`);
  });

  test("the JavaScript lane's read() on a JSON source throws the same fence", async () => {
    const r = await compileAndRun(
      "js-read-json-string",
      `'use strict';
const { Readable } = require('node:stream');
const r = Readable.from(JSON.parse('["j1"]'));
r.once('readable', () => {
  try {
    const chunk = r.read();
    console.log('got', chunk === null ? 'null' : chunk.length);
  } catch (err) {
    console.log('caught', err.message);
  }
});
`,
      "cjs",
    );
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe(`caught ${READ_FENCE_MESSAGE}\n`);
  });

  test("a dynamic source that mixes Buffers and strings yields each as it is, as Node does", async () => {
    const r = await compileAndRun(
      "mixed-dynamic-source",
      `import { Readable } from "node:stream";
const values: any = JSON.parse('["s1"]');
values.unshift(Buffer.from("b1"));
const r = Readable.from(values);
r.on("data", (c: any) => console.log("data", Buffer.isBuffer(c), String(c)));
r.on("error", (err: Error) => console.log("error", err.message));
r.on("close", () => console.log("close"));
`,
    );
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe("data true b1\ndata false s1\nclose\n");
  });
});
