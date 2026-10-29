import { spawn } from "node:child_process";
import { fileURLToPath } from "url";
import dotenv from "dotenv";

import { mergePathEntries, resolveLoginShellPath } from "./login-shell-env.js";

dotenv.config({
  path: fileURLToPath(new URL("../.env", import.meta.url)),
  quiet: true,
});

const daemonRunnerEntry = fileURLToPath(new URL("./supervisor-entrypoint.ts", import.meta.url));

const supervisorArgs = [...process.execArgv, daemonRunnerEntry, "--dev", ...process.argv.slice(2)];

// This process was not started from an interactive shell, so its PATH is bare and
// providers cannot find the user's tools. Merge the login-shell PATH in before
// the supervisor (and the daemon it owns) inherits it.
const mergedPath = mergePathEntries(process.env.PATH, resolveLoginShellPath() ?? undefined);

const supervisor = spawn(process.execPath, supervisorArgs, {
  stdio: "inherit",
  env: {
    ...process.env,
    ...(mergedPath ? { PATH: mergedPath } : {}),
    PASEO_LOG_FORMAT: process.env.PASEO_LOG_FORMAT ?? "pretty",
  },
});

function exitCodeForSignal(signal: NodeJS.Signals): number {
  return signal === "SIGINT" ? 130 : 1;
}

function forwardSignal(signal: NodeJS.Signals): void {
  if (supervisor.exitCode !== null || supervisor.signalCode !== null || supervisor.killed) {
    return;
  }
  supervisor.kill(signal);
}

// The supervisor handles SIGINT/SIGTERM itself and needs time to drain the
// worker gracefully. Keep this wrapper alive until the supervisor exits so npm
// does not release the shell while the daemon is still logging final shutdown.
process.on("SIGINT", () => forwardSignal("SIGINT"));
process.on("SIGTERM", () => forwardSignal("SIGTERM"));

supervisor.on("error", (error) => {
  throw error;
});

supervisor.on("exit", (code, signal) => {
  process.exit(code ?? (signal ? exitCodeForSignal(signal) : 1));
});
