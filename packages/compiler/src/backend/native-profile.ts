/** Profile-guided optimization for helper-compiled executables.
 *
 * An instrumented build (`--profile-generate`) counts how often each branch
 * and call runs and writes the counts when the program exits. `scriptc
 * merge-profiles` turns those raw profiles into one indexed profile, and an
 * optimized build (`--profile-use`) lays out, inlines, and splits code by it.
 * The helper applies both in the pre-link pipeline of every partition.
 */
import type { NativeOptimization } from "./optimization.js";

export interface NativeProfileOptions {
  /** Raw profile path pattern written by the instrumented executable. */
  generate?: string;
  /** Indexed profile and the digest of its bytes, which key every cache. */
  use?: { path: string; digest: string };
}

/** Why a request cannot use profiles, or null when it can. */
export function nativeProfileRefusal(options: {
  profileGenerate?: string;
  profileUse?: string;
  outputKind: string;
  optimization: NativeOptimization;
  sanitize: boolean;
  platform: string;
}): string | null {
  const generate = options.profileGenerate !== undefined;
  const use = options.profileUse !== undefined;
  if (!generate && !use) return null;
  const flag = generate ? "--profile-generate" : "--profile-use";
  if (generate && use) return "--profile-generate and --profile-use cannot be combined";
  if (options.outputKind !== "exe") return `${flag} is only supported for executable output`;
  if (options.sanitize) return `${flag} cannot be combined with --sanitize`;
  if (options.optimization === "dev")
    return `${flag} needs an optimized build (--optimization=release or speed)`;
  if (generate && options.platform !== "linux")
    return "--profile-generate is only supported for Linux executables";
  return null;
}

export function nativeProfileHelperArgs(profile: NativeProfileOptions | undefined): string[] {
  if (profile?.generate !== undefined) return ["--profile-generate", profile.generate];
  if (profile?.use !== undefined) return ["--profile-use", profile.use.path];
  return [];
}

/** Cache-key part; empty without a profile so other keys are unchanged. */
export function nativeProfileKey(profile: NativeProfileOptions | undefined): string {
  if (profile?.generate !== undefined) return `profile-generate:${profile.generate}`;
  if (profile?.use !== undefined) return `profile-use:${profile.use.digest}`;
  return "";
}

/** The instrumented link adds the compiler driver's profile runtime. */
export function profileGenerateLinkerArgs(generate: boolean): string[] {
  return generate ? ["-fprofile-generate"] : [];
}
