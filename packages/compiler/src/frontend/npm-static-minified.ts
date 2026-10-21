/** Minified package entries resolve to their unminified siblings when the
 * two are provably the same program. Packages built with tshy and esbuild
 * (lru-cache 11, glob 13) point their exports at one `index.min.js` bundle
 * and still ship the per-file build next to it (`index.js`, …) with source
 * maps. The bundle cannot be compiled readably, but the per-file build can,
 * so an opted-in package's minified target is respelled to the sibling when
 * all of these hold:
 *   - the target looks minified (the eligibility heuristic's own test) and
 *     a sibling with the same name minus `.min` exists;
 *   - the bundle's source map lists every source with its content, and the
 *     per-file module graph reached from the sibling (relative edges and the
 *     installed dependencies Node would load, through their source maps)
 *     compiles exactly the same sources with byte-identical content — so a
 *     dependency inlined into the bundle at build time must match the
 *     installed version the per-file build would import;
 *   - the bundle and the sibling export the same names.
 * Anything else keeps the minified target, and the reason is recorded for
 * the eligibility refusal. */
import { dirname, join, relative, resolve } from "node:path";
import { canonicalBuiltinModule } from "./builtin-modules.js";
import { trackedExists, trackedReadFile } from "./input-tracker.js";

/** One runtime module edge of a JavaScript file: the specifier and whether
 * an import (static or dynamic) or a require loads it. */
export interface ModuleEdge {
  specifier: string;
  imported: boolean;
  required: boolean;
}

/** A module's own export names and the specifiers it re-exports whole
 * (ES `export * from`, or the CommonJS lexer's reexports). Hosts answer
 * null for an export shape the comparison cannot name. */
export interface ModuleExportNames {
  esm: boolean;
  names: string[];
  reexports: string[];
}

/** The services verification needs from the load that owns resolution:
 * syntax answers over parsed JavaScript (npm-static-minified-syntax.ts)
 * and the opted-in runtime resolver (`resolveBareModule` in js-only mode,
 * which resolves dependencies through the same respelled package.json
 * documents). */
export interface MinifiedEntryHost {
  moduleEdges: (path: string, source: string) => ModuleEdge[];
  moduleExports: (path: string, source: string) => ModuleExportNames | null;
  resolveBare: (fromFile: string, specifier: string, kind: "import" | "require") => string | null;
}

let host: MinifiedEntryHost | null = null;
/** Per-load verdicts by minified file path: null when verified, else the
 * refusal reason. */
const verdicts = new Map<string, string | null>();
const inProgress = new Set<string>();

export function setMinifiedEntryHost(next: MinifiedEntryHost | null): void {
  host = next;
  verdicts.clear();
}

/** Unminified-JS heuristic over an entry source: at least two lines and
 * an average line length under 200 characters (minified dists are one
 * enormous line; readable code averages well under 100). */
export function looksUnminified(source: string): boolean {
  const lines = source.split("\n");
  if (lines.length < 2) return false;
  return source.length / lines.length <= 200;
}

const MIN_NAME = /\.min(\.[cm]?js)$/;

/** The verified unminified sibling for a package.json target string
 * (`./dist/esm/index.min.js` → `./dist/esm/index.js`), else the target. */
export function unminifiedTarget(pkgDir: string, target: string): string {
  if (!MIN_NAME.test(target) || !target.startsWith("./")) return target;
  const verdict = verifyMinifiedEntry(join(pkgDir, target));
  return verdict === null ? target.replace(MIN_NAME, "$1") : target;
}

/** Why a minified entry did not resolve to its sibling, or null when it
 * has no `.min` sibling candidate or was verified. */
export function minifiedEntryRefusal(file: string): string | null {
  if (!MIN_NAME.test(file)) return null;
  return verifyMinifiedEntry(file);
}

/** Null when the minified file's sibling is verified, else the reason. */
function verifyMinifiedEntry(file: string): string | null {
  const norm = resolve(file);
  if (verdicts.has(norm)) return verdicts.get(norm) ?? null;
  // A dependency cycle through two minified entries resolves the inner one
  // unverified (its bundle then appears in the per-file graph and fails
  // the comparison).
  if (inProgress.has(norm)) return "its verification depends on itself";
  inProgress.add(norm);
  let verdict: string | null;
  try {
    verdict = verify(norm);
  } catch {
    verdict = "its source maps could not be read";
  } finally {
    inProgress.delete(norm);
  }
  verdicts.set(norm, verdict);
  return verdict;
}

function verify(minFile: string): string | null {
  const sibling = minFile.replace(MIN_NAME, "$1");
  const h = host;
  if (h === null) return "no verifier is active";
  const minSource = trackedReadFile(minFile);
  if (minSource === null) return `${minFile} cannot be read`;
  if (looksUnminified(minSource)) return "it is not minified";
  if (!trackedExists(sibling)) return `it has no unminified sibling ${sibling}`;
  const bundled = sourcesOf(minFile, minSource);
  if (bundled === null) return "its bundle has no source map with source contents";

  // The per-file graph Node would load from the sibling.
  const compiled = new Map<string, string>();
  const seen = new Set<string>();
  const queue = [sibling];
  while (queue.length > 0) {
    const file = queue.pop();
    if (file === undefined) break;
    if (seen.has(file)) continue;
    seen.add(file);
    const source = trackedReadFile(file);
    if (source === null) return `${file} cannot be read`;
    const mapped = file.endsWith(".json") ? null : sourcesOf(file, source);
    const contributed = new Map<string, string>();
    if (mapped === null) contributed.set(sourceKey(file), source);
    else for (const [key, content] of mapped) contributed.set(key, content);
    for (const [key, content] of contributed) {
      const prior = compiled.get(key);
      if (prior !== undefined && prior !== content) {
        return `two installed copies of ${key} differ`;
      }
      compiled.set(key, content);
    }
    if (file.endsWith(".json")) continue;
    for (const edge of h.moduleEdges(file, source)) {
      const spec = edge.specifier;
      if (spec.startsWith("node:") || canonicalBuiltinModule(spec) !== null) continue;
      const kinds: ("import" | "require")[] = [];
      if (edge.imported) kinds.push("import");
      if (edge.required) kinds.push("require");
      for (const kind of kinds) {
        const target =
          spec.startsWith("./") || spec.startsWith("../")
            ? relativeTarget(file, spec, kind)
            : h.resolveBare(file, spec, kind);
        if (target === null) return `'${spec}' does not resolve from ${file}`;
        queue.push(target);
      }
    }
  }

  for (const [key, content] of bundled) {
    const per = compiled.get(key);
    if (per === undefined) {
      return `the bundle inlines ${key}, which its per-file build does not load`;
    }
    if (per !== content) {
      return `the bundle inlines a ${key} that differs from the installed one its per-file build loads`;
    }
  }
  for (const key of compiled.keys()) {
    if (!bundled.has(key)) {
      return `its per-file build loads ${key}, which the bundle does not contain`;
    }
  }
  const minExports = exportNames(h, minFile, minSource);
  const siblingExports = exportNames(h, sibling, trackedReadFile(sibling) ?? "");
  if (minExports === null || siblingExports === null || minExports !== siblingExports) {
    return "its bundle and its per-file entry export different names";
  }
  return null;
}

/** A relative edge resolved the way Node does for the edge's kind: ESM
 * specifiers name the file exactly; require also tries the extensions and
 * a directory index. */
function relativeTarget(from: string, spec: string, kind: "import" | "require"): string | null {
  const base = resolve(dirname(from), spec);
  const candidates =
    kind === "import"
      ? [base]
      : [base, `${base}.js`, `${base}.cjs`, `${base}.json`, join(base, "index.js")];
  for (const candidate of candidates) {
    if (trackedExists(candidate) && trackedReadFile(candidate) !== null) return candidate;
  }
  return null;
}

/** The source map's (source → content) pairs, keyed package-relative so a
 * bundle's build-time `node_modules/minimatch/src/index.ts` and the
 * installed `minimatch/src/index.ts` compare. Null without a map file, or
 * when any source lacks its content. */
function sourcesOf(file: string, source: string): Map<string, string> | null {
  const url = /\/\/# sourceMappingURL=(\S+)\s*$/.exec(source)?.[1];
  if (url === undefined || url.includes(":")) return null;
  const mapFile = resolve(dirname(file), url);
  const text = trackedReadFile(mapFile);
  if (text === null) return null;
  const parsed: unknown = JSON.parse(text);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const map = parsed as Record<string, unknown>;
  const sources = map["sources"];
  const contents = map["sourcesContent"];
  const rootValue = map["sourceRoot"];
  if (
    map["version"] !== 3 ||
    !Array.isArray(sources) ||
    !Array.isArray(contents) ||
    sources.length !== contents.length
  )
    return null;
  const root = typeof rootValue === "string" ? rootValue : "";
  if (root.includes(":")) return null;
  const out = new Map<string, string>();
  for (let i = 0; i < sources.length; i++) {
    const entry: unknown = sources[i];
    const content: unknown = contents[i];
    if (typeof entry !== "string" || entry.includes(":") || typeof content !== "string") {
      return null;
    }
    out.set(sourceKey(resolve(dirname(mapFile), root, entry)), content);
  }
  return out;
}

/** `pkg/rest` below the innermost node_modules, else the path relative to
 * the nearest named package root (a workspace package), else the path. */
function sourceKey(path: string): string {
  const norm = path.split("\\").join("/");
  const idx = norm.lastIndexOf("/node_modules/");
  if (idx !== -1) return norm.slice(idx + "/node_modules/".length);
  for (let dir = dirname(norm); ;) {
    const pkg = trackedReadFile(join(dir, "package.json"));
    if (pkg !== null) {
      try {
        const parsed: unknown = JSON.parse(pkg);
        const name =
          parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
            ? (parsed as Record<string, unknown>)["name"]
            : undefined;
        if (typeof name === "string" && name !== "") return `${name}/${relative(dir, norm)}`;
      } catch {
        /* malformed: keep walking */
      }
    }
    const parent = dirname(dir);
    if (parent === dir) return norm;
    dir = parent;
  }
}

/** The names a module exports, as one sorted key: its own names plus,
 * recursively, the names of every module it re-exports whole (never their
 * `default`). Null when some shape or edge cannot be named. */
function exportNames(h: MinifiedEntryHost, file: string, source: string): string | null {
  const top = h.moduleExports(file, source);
  if (top === null) return null;
  const names = new Set<string>();
  const visiting = new Set<string>();
  const visit = (path: string, own: ModuleExportNames, star: boolean): boolean => {
    if (visiting.has(path)) return true;
    visiting.add(path);
    for (const name of own.names) {
      if (!(star && name === "default")) names.add(name);
    }
    const kind = own.esm ? "import" : "require";
    for (const spec of own.reexports) {
      if (spec.startsWith("node:") || canonicalBuiltinModule(spec) !== null) return false;
      const target =
        spec.startsWith("./") || spec.startsWith("../")
          ? relativeTarget(path, spec, kind)
          : h.resolveBare(path, spec, kind);
      if (target === null) return false;
      const text = trackedReadFile(target);
      if (text === null) return false;
      const inner = h.moduleExports(target, text);
      if (inner === null || !visit(target, inner, true)) return false;
    }
    return true;
  };
  if (!visit(file, top, false)) return null;
  return [...names].sort().join(",");
}
