import { spawnSync } from "node:child_process";

/**
 * The dev daemon is spawned by a non-interactive Node process, so it inherits a
 * bare PATH and cannot see tools the user installed on their interactive shell
 * PATH (brew shims, `~/.opencode/bin`, `~/.hermes/node/bin`, ...). Providers
 * resolve their binaries from the daemon's PATH, so those providers report
 * unavailable and never load models.
 *
 * The packaged desktop app resolves the login-shell env before starting its
 * daemon (see packages/desktop/src/login-shell-env.ts). The dev runner has to do
 * the same. Only PATH is merged: the dev environment already sets everything
 * else the daemon needs, and letting an rc file overwrite it would be worse.
 */

const LOGIN_SHELL_ENV_TIMEOUT_MS = 15_000;

type SpawnSyncLike = typeof spawnSync;

export interface ResolveLoginShellPathOptions {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  timeoutMs?: number;
  spawn?: SpawnSyncLike;
}

/** Union of path entries, keeping `base` first so dev-provided dirs still win. */
export function mergePathEntries(
  base: string | undefined,
  extra: string | undefined,
): string | undefined {
  const entries: string[] = [];
  const seen = new Set<string>();
  for (const list of [base, extra]) {
    for (const entry of list?.split(":") ?? []) {
      if (!entry || seen.has(entry)) continue;
      seen.add(entry);
      entries.push(entry);
    }
  }
  return entries.length > 0 ? entries.join(":") : undefined;
}

/**
 * PATH of the user's login shell, or null when it cannot be resolved (Windows,
 * no SHELL, shell failure, timeout). `env` is used rather than `echo $PATH`
 * because fish prints PATH as a space-separated list.
 */
export function resolveLoginShellPath(options: ResolveLoginShellPathOptions = {}): string | null {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  if (platform === "win32") return null;

  const shell = env.SHELL?.trim();
  if (!shell) return null;

  const spawn = options.spawn ?? spawnSync;
  const timeoutMs = options.timeoutMs ?? LOGIN_SHELL_ENV_TIMEOUT_MS;

  for (const flags of [
    ["-l", "-i", "-c", "env"],
    ["-l", "-c", "env"],
  ]) {
    try {
      const result = spawn(shell, flags, { encoding: "utf8", timeout: timeoutMs, env });
      if (result.status !== 0) continue;
      const path = parseLastPathEntry(String(result.stdout ?? ""));
      if (path) return path;
    } catch {
      // A shell that fails or times out is not evidence the user has no PATH.
    }
  }
  return null;
}

function parseLastPathEntry(output: string): string | null {
  let found: string | null = null;
  for (const line of output.split("\n")) {
    if (!line.startsWith("PATH=")) continue;
    const value = line.slice("PATH=".length).trim();
    if (value) found = value;
  }
  return found;
}
