import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import pino from "pino";
import { describe, expect, test } from "vitest";

import { CommandCodeCliRuntime, resolveRuntimeCommand, type CommandCodeLaunch } from "./runtime.js";

function createFakeChild(): {
  child: ChildProcessWithoutNullStreams;
  stdout: PassThrough;
  close: (code: number) => void;
} {
  const emitter = new EventEmitter();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const stdin = new PassThrough();
  Object.assign(emitter, { stdout, stderr, stdin, kill: () => true });
  return {
    child: emitter as unknown as ChildProcessWithoutNullStreams,
    stdout,
    close: (code) => {
      stdout.end();
      stderr.end();
      emitter.emit("close", code, null);
    },
  };
}

describe("resolveRuntimeCommand", () => {
  test("defaults to the built-in binary", () => {
    expect(resolveRuntimeCommand(undefined, ["cmd"])).toEqual(["cmd"]);
    expect(resolveRuntimeCommand({ mode: "default" }, ["cmd"])).toEqual(["cmd"]);
  });

  test("replace mode supplies the whole argv", () => {
    expect(
      resolveRuntimeCommand({ mode: "replace", argv: ["/opt/cmd", "--verbose"] }, ["cmd"]),
    ).toEqual(["/opt/cmd", "--verbose"]);
  });

  test("append mode inserts args after the default binary", () => {
    expect(
      resolveRuntimeCommand({ mode: "append", args: ["--config", "theme=dark"] }, ["cmd"]),
    ).toEqual(["cmd", "--config", "theme=dark"]);
  });
});

describe("CommandCodeCliRuntime.probe", () => {
  test("spawns the CLI with only the probe args", async () => {
    const launches: CommandCodeLaunch[] = [];
    let fake: ReturnType<typeof createFakeChild> | undefined;
    const runtime = new CommandCodeCliRuntime({
      logger: pino({ level: "silent" }),
      command: ["cmd"],
      spawnProcessOverride: (launch) => {
        launches.push(launch);
        fake = createFakeChild();
        return fake.child;
      },
    });

    const result = runtime.probe(["--list-models"], { cwd: "/tmp" });
    // The binary must not be re-passed as an argument: `cmd cmd --list-models`
    // makes the CLI run a prompt instead of listing models.
    expect(launches[0]?.argv).toEqual(["--list-models"]);

    fake?.stdout.write("deepseek/deepseek-v4-pro\n");
    fake?.close(0);

    await expect(result).resolves.toContain("deepseek/deepseek-v4-pro");
  });
});
