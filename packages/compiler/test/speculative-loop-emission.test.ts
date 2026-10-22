import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile } from "../src/index.js";

async function emitLlvm(source: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-speculative-loop-"));
  try {
    const entry = join(dir, "main.ts");
    const outPath = join(dir, "main.ll");
    await writeFile(entry, source);
    const result = await compile(entry, { outDir: dir, outPath, outputKind: "llvm" });
    expect(result.ok, JSON.stringify(result.diagnostics)).toBe(true);
    return await readFile(outPath, "utf8");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const source = `
class Point {
  x: number;
  w = 0;
  constructor(x: number) {
    this.x = x;
  }
}
function scaled(points: Point[], scale: number): number {
  let s = 0;
  for (let i = 0; i < points.length; i++) {
    const p = points[i]!;
    p.w += 1;
    const k = p.x * scale;
    s += k * k;
  }
  return s;
}
console.log(scaled([new Point(1), new Point(2)], 2), scaled([new Point(1)], 0.5));
`;

function labels(fn: string): string[] {
  return [...fn.matchAll(/^([\w.]+):/gm)].map((m) => m[1]!);
}

test("a failed check finishes its iteration outside the ordinary copy", async () => {
  const llvm = await emitLlvm(source);
  const fn = /^define internal double @sc_bf_scaled\([^]*?^}/m.exec(llvm)?.[0] ?? "";
  const order = labels(fn);
  // The loop may have several speculative sites (one in each copy of a
  // dense-array loop). Each site emits its ordinary copy, its third copy
  // and its fast copy in that order.
  const slows = order.flatMap((l, i) => (l.startsWith("spec.slow") ? [i] : []));
  expect(slows.length).toBeGreaterThan(0);
  let resumes = 0;
  for (const slow of slows) {
    const next = (prefix: string): number =>
      order.findIndex((l, i) => i > slow && l.startsWith(prefix));
    const tail = next("spec.tail");
    const fast = next("spec.fast");
    expect(tail).toBeGreaterThan(slow);
    expect(fast).toBeGreaterThan(tail);
    // Every resume point of the site is in its third copy, between that
    // copy's start and the fast copy, so the ordinary copy has one entry.
    for (let i = slow + 1; i < fast; i++) {
      if (!order[i]!.startsWith("spec.resume")) continue;
      expect(i).toBeGreaterThan(tail);
      resumes++;
    }
    // The third copy's header leaves for the ordinary copy's header.
    const header = order[slow + 1]!;
    const third = fn.slice(fn.indexOf(`\n${order[tail]}:`), fn.indexOf(`\n${order[fast]}:`));
    expect(third).toContain(`br label %${header}`);
  }
  expect(resumes).toBe(order.filter((l) => l.startsWith("spec.resume")).length);
  expect(resumes).toBeGreaterThan(0);
});

test("a loop site stops entering its fast copy after repeated bails", async () => {
  const llvm = await emitLlvm(source);
  const site = /^(@scr\.spec\.bails\.\d+) = internal global i8 0$/m.exec(llvm)?.[1];
  expect(site).toBeDefined();
  const fn = /^define internal double @sc_bf_scaled\([^]*?^}/m.exec(llvm)?.[0] ?? "";
  const escaped = site!.replace(/\./g, "\\.");
  // The entry test reads the count, a bail adds one, and a completed fast
  // copy clears it.
  expect(fn).toMatch(
    new RegExp(
      `(%\\S+) = load atomic i8, ptr ${escaped} unordered, align 1\\n\\s*%\\S+ = icmp ult i8 \\1, 8`,
    ),
  );
  expect(fn).toMatch(new RegExp(`call i8 @llvm\\.uadd\\.sat\\.i8\\(i8 %\\S+, i8 1\\)`));
  expect(fn).toContain(`store atomic i8 0, ptr ${site} unordered, align 1`);
});
