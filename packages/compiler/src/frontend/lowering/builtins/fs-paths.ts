/* fs path arguments given as file: URLs. Node converts a URL path with
 * fileURLToPath inside each function (getValidatedPath), after every
 * argument has been evaluated, and validates some arguments before the
 * path and others after it. A URL-typed path lowers to the same
 * conversion (url.fileURLToPathUrl). The later arguments through the last
 * one with side effects are evaluated into hidden locals before the
 * conversion, in source order, so they run even when it throws and each
 * reads what it reads in Node. The conversion keeps Node's error order when every
 * earlier path is a URL too and each argument Node validates before the
 * path is absent or a literal that passes that validation; other URL
 * forms fence with SC2020, as do the fs.promises functions, whose
 * conversion errors are rejections rather than throws, and existsSync,
 * which answers false for a URL it cannot convert. */
import * as ts from "../../ts7/adapter.js";
import { type Lowerer } from "../lowerer.js";
import { locOf } from "../../program.js";
import { sideEffectFreeOptionValue } from "../surfaces.js";
import { stripTypeWrappers } from "../typed-arguments.js";
import { type IrExpr, type IrStmt, STRING, URL_T } from "../../../ir/ir.js";

/** The fs functions whose path parameters accept a URL: the path
 * parameter indexes, and whether Node validates the paths before every
 * other argument (otherwise the options come first). */
const FS_URL_PATHS: Readonly<
  Record<string, { readonly paths: readonly number[]; readonly pathsFirst: boolean }>
> = {
  accessSync: { paths: [0], pathsFirst: true },
  appendFileSync: { paths: [0], pathsFirst: false },
  chmodSync: { paths: [0], pathsFirst: true },
  chownSync: { paths: [0], pathsFirst: true },
  copyFileSync: { paths: [0, 1], pathsFirst: true },
  lchownSync: { paths: [0], pathsFirst: true },
  lstatSync: { paths: [0], pathsFirst: true },
  mkdirSync: { paths: [0], pathsFirst: false },
  mkdtempSync: { paths: [0], pathsFirst: false },
  openSync: { paths: [0], pathsFirst: true },
  opendirSync: { paths: [0], pathsFirst: true },
  readFileSync: { paths: [0], pathsFirst: false },
  readdirSync: { paths: [0], pathsFirst: false },
  realpathSync: { paths: [0], pathsFirst: false },
  "realpathSync.native": { paths: [0], pathsFirst: false },
  renameSync: { paths: [0, 1], pathsFirst: true },
  rmSync: { paths: [0], pathsFirst: false },
  rmdirSync: { paths: [0], pathsFirst: true },
  statSync: { paths: [0], pathsFirst: true },
  truncateSync: { paths: [0], pathsFirst: true },
  unlinkSync: { paths: [0], pathsFirst: true },
  writeFileSync: { paths: [0], pathsFirst: false },
};

/** The fs.promises functions with path parameters, by path indexes. */
const FSP_PATHS: Readonly<Record<string, readonly number[]>> = {
  access: [0],
  appendFile: [0],
  chmod: [0],
  chown: [0],
  copyFile: [0, 1],
  lchown: [0],
  lstat: [0],
  mkdir: [0],
  mkdtemp: [0],
  open: [0],
  opendir: [0],
  readFile: [0],
  readdir: [0],
  realpath: [0],
  rename: [0, 1],
  rm: [0],
  rmdir: [0],
  stat: [0],
  truncate: [0],
  unlink: [0],
  writeFile: [0],
};

function isUrlArgument(lowerer: Lowerer, node: ts.Expression | undefined): boolean {
  return node !== undefined && lowerer.mapTypeOf(lowerer.typeOf(node))?.kind === "url";
}

/** A literal that Node's option validation accepts before it reads the
 * path: a string (the checker admits only the declared encodings, flags
 * and type names), a boolean, an integer in [0, 2^31 - 1] (every numeric
 * option of these functions accepts that range), undefined or null, or an
 * object literal of those. */
function preValidatedLiteral(node: ts.Expression): boolean {
  let e = node;
  while (ts.isParenthesizedExpression(e)) e = e.expression;
  if (ts.isStringLiteralLike(e)) return true;
  if (
    e.kind === ts.SyntaxKind.TrueKeyword ||
    e.kind === ts.SyntaxKind.FalseKeyword ||
    e.kind === ts.SyntaxKind.NullKeyword
  )
    return true;
  if (ts.isIdentifier(e)) return e.text === "undefined";
  if (ts.isNumericLiteral(e)) {
    const value = Number(e.text);
    return Number.isInteger(value) && value >= 0 && value <= 2147483647;
  }
  if (ts.isObjectLiteralExpression(e)) {
    return e.properties.nodes.every(
      (p) =>
        ts.isPropertyAssignment(p) &&
        !ts.isComputedPropertyName(p.name) &&
        preValidatedLiteral(p.initializer),
    );
  }
  return false;
}

/** SC2020 when the call passes a URL path in a form whose conversion
 * order would differ from Node's (see the file comment). */
function checkUrlPaths(
  lowerer: Lowerer,
  call: ts.CallExpression,
  module: string,
  member: string,
): void {
  const args = call.arguments.nodes;
  const name = module === "fs/promises" ? `fs.promises.${member}` : member;
  const hint = "convert the URL first: fileURLToPath(url) from node:url";
  if (module === "fs/promises") {
    if ((FSP_PATHS[member] ?? []).some((i) => isUrlArgument(lowerer, args[i])))
      lowerer.noLowering(`${name} with a URL path`, call, hint);
    return;
  }
  if (member === "existsSync" && isUrlArgument(lowerer, args[0]))
    lowerer.noLowering(`${name} with a URL path`, call, hint);
  const row = FS_URL_PATHS[member];
  if (!row) return;
  const first = row.paths.find((i) => isUrlArgument(lowerer, args[i]));
  if (first === undefined) return;
  if (args.some(ts.isSpreadElement))
    lowerer.noLowering(`${name} with spread arguments and a URL path`, call);
  // The runtime checks a string path after the conversion, so a string
  // path Node checks first cannot precede the URL.
  if (row.paths.some((i) => i < first && args[i] !== undefined))
    lowerer.noLowering(`${name} with a string path before a URL path`, call, hint);
  // Every argument from the URL through the last one with effects is
  // evaluated ahead of the conversion, in source order: a later argument's
  // effect (an assignment, say) must not change what an earlier one read.
  let last = first;
  for (let i = first + 1; i < args.length; i++) if (!sideEffectFreeOptionValue(args[i]!)) last = i;
  const staged: ts.Expression[] = [];
  for (let i = first + 1; i <= last; i++) {
    // Keyed without type-only wrappers (`satisfies`, `as`, `!`), so a
    // lowering that reads through them finds the saved value.
    const e = stripTypeWrappers(args[i]!);
    // Literals are read by their members, so a whole-value slot cannot
    // hold them.
    if (ts.isObjectLiteralExpression(e) || ts.isArrayLiteralExpression(e)) {
      lowerer.noLowering(
        sideEffectFreeOptionValue(e)
          ? `${name} with a URL path and a literal before a later argument that has effects`
          : `${name} with a URL path and a later literal that has effects`,
        e,
        hint,
      );
    }
    staged.push(e);
  }
  if (staged.length > 0) {
    lowerer.stagedAfterPath.set(args[first]!, staged);
    for (const e of staged) lowerer.stagedArguments.set(e, null);
  }
  if (row.pathsFirst) return;
  // writeFileSync/appendFileSync's data is checked after the path.
  const data = member === "writeFileSync" || member === "appendFileSync" ? 1 : -1;
  for (let i = 0; i < args.length; i++) {
    if (row.paths.includes(i) || i === data || preValidatedLiteral(args[i]!)) continue;
    lowerer.noLowering(`${name} with a URL path and options that are not literals`, args[i]!, hint);
  }
}

/** Fences URL paths that cannot convert in Node's order: the check every
 * fs and fs.promises call runs before lowering its arguments. */
export function checkFsUrlPaths(
  lowerer: Lowerer,
  call: ts.CallExpression,
  bi: { module: string; member: string },
): void {
  if (bi.module === "fs" || bi.module === "fs/promises")
    checkUrlPaths(lowerer, call, bi.module, bi.member);
}

/** An fs path argument as a string: a URL converts with fileURLToPath's
 * conversion (url.fileURLToPathUrl), which throws Node's errors for other
 * schemes, hosts and encoded separators. */
export function lowerFsPath(lowerer: Lowerer, node: ts.Expression): IrExpr {
  if (!isUrlArgument(lowerer, node)) return lowerer.lowerExprExpecting(node, STRING);
  const loc = locOf(node);
  const url = lowerer.lowerExprExpecting(node, URL_T);
  const staged = lowerer.stagedAfterPath.get(node);
  if (staged === undefined)
    return { kind: "libCall", fn: "url.fileURLToPathUrl", args: [url], type: STRING, loc };
  // The URL and the later arguments with effects, in source order, then
  // the conversion.
  const saved = lowerer.declareHiddenLocal("%fsUrl", URL_T);
  const stmts: IrStmt[] = [{ kind: "varDecl", localId: saved.id, init: url, loc }];
  for (const arg of staged) {
    lowerer.stagedArguments.delete(arg);
    const value = lowerer.lowerExpr(arg);
    const slot = lowerer.declareHiddenLocal("%fsArg", value.type);
    stmts.push({ kind: "varDecl", localId: slot.id, init: value, loc: locOf(arg) });
    lowerer.stagedArguments.set(arg, { localId: slot.id, type: value.type });
  }
  return {
    kind: "seqExpr",
    stmts,
    result: {
      kind: "libCall",
      fn: "url.fileURLToPathUrl",
      args: [{ kind: "varRef", localId: saved.id, type: URL_T, loc }],
      type: STRING,
      loc,
    },
    type: STRING,
    loc,
  };
}

/** Whether `index` is a path parameter of the fs function `member`. */
export function isFsPathParam(member: string, index: number): boolean {
  return FS_URL_PATHS[member]?.paths.includes(index) === true;
}
