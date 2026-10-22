import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { USES_TIMERS_LIB_FNS } from "../backend/llvm/lib-shared.js";
import { libnodeCacheKey, libnodeRecord, NODE_BRIDGE_ABI } from "./libnode.js";
import { findInstalledLibnodePack, hostLibnodeTarget } from "./libnode-pack.js";

function pack(nodeVersion: string, bridgeAbi = NODE_BRIDGE_ABI): string {
  const dir = mkdtempSync(join(tmpdir(), "scriptc-libnode-"));
  writeFileSync(join(dir, "libnode.so.137"), "lib");
  writeFileSync(join(dir, "libscr_node_bridge.so"), "bridge");
  writeFileSync(
    join(dir, "manifest.json"),
    JSON.stringify({
      nodeVersion,
      bridgeAbi,
      files: { "libnode.so.137": {}, "libscr_node_bridge.so": {} },
    }),
  );
  return dir;
}

describe("the recorded libnode pack", () => {
  test("records the pack directory and its exact Node version", () => {
    const dir = pack("24.22.0");
    expect(libnodeRecord(dir, "/out/app", {})).toEqual({ libnode: dir, nodeVersion: "24.22.0" });
    expect(libnodeRecord(undefined, "/out/app", { SCRIPTC_LIBNODE: dir })).toEqual({
      libnode: dir,
      nodeVersion: "24.22.0",
    });
  });

  test("refuses a missing, too old or incompatible pack", () => {
    // Unless a workspace build of the host's @scriptc/libnode-<platform>
    // resolves next to the compiler, which libnodeRecord then uses.
    const installed = findInstalledLibnodePack({
      targetName: hostLibnodeTarget(),
      projectDir: "/nonexistent",
    });
    if (installed === null) {
      expect(libnodeRecord(undefined, "/out/app", {}, "/nonexistent")).toMatch(
        /no libnode pack is installed/,
      );
    } else {
      expect(libnodeRecord(undefined, "/out/app", {}, "/nonexistent")).toMatchObject({
        libnode: installed,
      });
    }
    expect(libnodeRecord("/nonexistent", "/out/app", {})).toBe(
      "no libnode pack at /nonexistent (manifest.json is missing or unreadable)",
    );
    expect(libnodeRecord(pack("24.12.0"), "/out/app", {})).toMatch(
      /is Node 24\.12\.0; Node islands need Node\.js >=24\.13\.1$/,
    );
    expect(libnodeRecord(pack("24.22.0", 99), "/out/app", {})).toMatch(/has bridge ABI 99/);
    expect(libnodeRecord("relative/pack", "/out/app", {})).toBe(
      "the libnode pack directory must be absolute, got 'relative/pack'",
    );
  });

  test("beside copies the pack next to the executable and records it relative to it", () => {
    const dir = pack("24.22.0");
    const out = mkdtempSync(join(tmpdir(), "scriptc-libnode-out-"));
    mkdirSync(out, { recursive: true });
    expect(libnodeRecord("beside", join(out, "app"), { SCRIPTC_LIBNODE: dir })).toEqual({
      libnode: "$ORIGIN/app.libnode",
      nodeVersion: "24.22.0",
    });
    expect(readFileSync(join(out, "app.libnode/libscr_node_bridge.so"), "utf8")).toBe("bridge");
    expect(existsSync(join(out, "app.libnode/manifest.json"))).toBe(true);
  });

  test("beside places the pack again after the outputs were deleted", () => {
    // A cached executable restored without its pack gets it again (compile, index.ts).
    const dir = pack("24.22.0");
    const out = mkdtempSync(join(tmpdir(), "scriptc-libnode-out-"));
    libnodeRecord("beside", join(out, "app"), { SCRIPTC_LIBNODE: dir });
    rmSync(join(out, "app.libnode"), { recursive: true, force: true });
    expect(libnodeRecord("beside", join(out, "app"), { SCRIPTC_LIBNODE: dir })).toEqual({
      libnode: "$ORIGIN/app.libnode",
      nodeVersion: "24.22.0",
    });
    expect(readFileSync(join(out, "app.libnode/libscr_node_bridge.so"), "utf8")).toBe("bridge");
  });

  test("a pack the deployment places beside the executable needs no manifest at build time", () => {
    expect(libnodeRecord("$ORIGIN/node", "/out/app", {})).toEqual({
      libnode: "$ORIGIN/node",
      nodeVersion: "",
    });
  });
});

describe("the libnode pack in an executable's cache key", () => {
  test("is absent without --libnode or SCRIPTC_LIBNODE", () => {
    expect(libnodeCacheKey(undefined, {})).toBeUndefined();
  });

  test("changes when the pack in the same directory is upgraded", () => {
    const dir = pack("24.22.0");
    const before = libnodeCacheKey(dir, {});
    expect(libnodeCacheKey(dir, {})).toBe(before);
    writeFileSync(
      join(dir, "manifest.json"),
      JSON.stringify({ nodeVersion: "24.23.0", bridgeAbi: NODE_BRIDGE_ABI, files: {} }),
    );
    expect(libnodeCacheKey(dir, {})).not.toBe(before);
  });

  test("names the pack beside copies from", () => {
    const a = pack("24.22.0");
    const b = pack("24.22.0");
    expect(libnodeCacheKey("beside", { SCRIPTC_LIBNODE: a })).not.toBe(
      libnodeCacheKey("beside", { SCRIPTC_LIBNODE: b }),
    );
    expect(libnodeCacheKey("beside", { SCRIPTC_LIBNODE: a })).not.toBe(libnodeCacheKey(a, {}));
  });
});

test("calls into Node keep the program's event loop running", () => {
  // Node's ref'd timers and I/O run on the program's loop (scr_node_island.c).
  expect(USES_TIMERS_LIB_FNS.has("nodeIsland.call")).toBe(true);
  expect(USES_TIMERS_LIB_FNS.has("nodeIsland.callSync")).toBe(true);
});
