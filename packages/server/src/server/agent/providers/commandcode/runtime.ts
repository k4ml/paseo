import { randomUUID } from "node:crypto";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import type { Logger } from "pino";

import { spawnProcess } from "../../../../utils/spawn.js";
import { signalProcessTree } from "../../../../utils/tree-kill.js";
import type { ProviderRuntimeSettings } from "../../provider-launch-config.js";
import {
  createCommandCodeStreamParser,
  type CommandCodeFrame,
  type CommandCodeResultFrame,
} from "./ndjson.js";

export const DEFAULT_COMMANDCODE_COMMAND: [string, ...string[]] = [
  process.env.COMMANDCODE_COMMAND ?? "cmd",
];

export interface CommandCodeLaunch {
  cwd: string;
  argv: string[];
  env?: Record<string, string>;
}

export type CommandCodeRuntimeEvent =
  | {
      type: "frame";
      frame: CommandCodeFrame;
    }
  | {
      type: "exit";
      code: number | null;
      signal: NodeJS.Signals | null;
      error?: string;
    };

export interface CommandCodeRuntimeSession {
  readonly sessionId: string | null;
  readonly finalText: string;
  readonly usage: CommandCodeResultFrame["usage"] | undefined;
  readonly stderr: string;
  readonly exitCode: number | null;
  readonly exitSignal: NodeJS.Signals | null;
  onEvent(callback: (event: CommandCodeRuntimeEvent) => void): () => void;
  /** True once the child process has exited. */
  hasExited(): boolean;
  interrupt(): Promise<void>;
  close(): Promise<void>;
}

export interface CommandCodeRuntime {
  run(launch: CommandCodeLaunch, signal?: AbortSignal): Promise<CommandCodeRuntimeSession>;
  /** Probe the CLI (e.g. `cmd --list-models`) and return its stdout. */
  probe(argv: string[], options?: { cwd?: string; timeoutMs?: number }): Promise<string | null>;
}

export interface CommandCodeRuntimeOptions {
  logger: Logger;
  runtimeSettings?: ProviderRuntimeSettings;
  command?: [string, ...string[]];
  spawnProcessOverride?: (launch: CommandCodeLaunch) => ChildProcessWithoutNullStreams;
}

const STDERR_BUFFER_LIMIT = 16 * 1024;
const GRACEFUL_INTERRUPT_TIMEOUT_MS = 2_000;
const INTERRUPT_SETTLE_TIMEOUT_MS = 5_000;

export class CommandCodeCliRuntime implements CommandCodeRuntime {
  private readonly logger: Logger;
  private readonly command: [string, ...string[]];
  private readonly env: Record<string, string> | undefined;
  private readonly spawnProcessOverride?: (
    launch: CommandCodeLaunch,
  ) => ChildProcessWithoutNullStreams;

  constructor(options: CommandCodeRuntimeOptions) {
    this.logger = options.logger;
    this.command = options.command ?? DEFAULT_COMMANDCODE_COMMAND;
    this.env = options.runtimeSettings?.env;
    this.spawnProcessOverride = options.spawnProcessOverride;
  }

  async run(launch: CommandCodeLaunch, signal?: AbortSignal): Promise<CommandCodeRuntimeSession> {
    if (signal?.aborted) {
      throw new Error("Command Code run aborted before launch");
    }
    const child = this.spawnChild(launch);
    const session = new CommandCodeCliRuntimeSession(this.logger, child, signal);
    return session;
  }

  async probe(
    argv: string[],
    options?: { cwd?: string; timeoutMs?: number },
  ): Promise<string | null> {
    const command = this.command[0];
    const args = [...this.command.slice(1), ...argv];
    const child = this.spawnChild({
      cwd: options?.cwd ?? process.cwd(),
      argv: [command, ...args],
    });
    const timeoutMs = options?.timeoutMs ?? 15_000;

    let stdout = "";
    const outputPromise = new Promise<string | null>((resolve) => {
      const onData = (chunk: Buffer) => {
        stdout += chunk.toString("utf8");
        if (stdout.length > STDERR_BUFFER_LIMIT) {
          stdout = stdout.slice(-STDERR_BUFFER_LIMIT);
        }
      };
      const onError = () => resolve(null);
      const onClose = (code: number | null) => resolve(code === 0 ? stdout : null);
      child.stdout.on("data", onData);
      child.once("error", onError);
      child.once("close", onClose);
    });

    const timeoutPromise = new Promise<null>((resolve) => {
      const timer = setTimeout(() => {
        void signalProcessTree(child, "SIGKILL");
        resolve(null);
      }, timeoutMs);
      child.once("close", () => clearTimeout(timer));
    });

    return await Promise.race([outputPromise, timeoutPromise]);
  }

  private spawnChild(launch: CommandCodeLaunch): ChildProcessWithoutNullStreams {
    if (this.spawnProcessOverride) {
      return this.spawnProcessOverride(launch);
    }
    const [command, ...baseArgs] = this.command;
    const child = spawnProcess(command, [...baseArgs, ...launch.argv], {
      cwd: launch.cwd,
      envOverlay: this.env,
    });
    if (!child.stdin || !child.stdout || !child.stderr) {
      child.kill();
      throw new Error("Command Code process was spawned without stdio streams");
    }
    return child as ChildProcessWithoutNullStreams;
  }
}

class CommandCodeCliRuntimeSession implements CommandCodeRuntimeSession {
  private readonly subscribers = new Set<(event: CommandCodeRuntimeEvent) => void>();
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly logger: Logger;
  private readonly abortHandler: () => void;
  private readonly disposeStreamParser: () => void;
  private exited = false;
  private exitError: string | null = null;
  private capturedSessionId: string | null = null;
  private capturedFinalText = "";
  private capturedUsage: CommandCodeResultFrame["usage"] | undefined;
  private capturedStderr = "";
  private capturedExitCode: number | null = null;
  private capturedExitSignal: NodeJS.Signals | null = null;
  private interruptPromise: Promise<void> | null = null;
  private closed = false;

  constructor(logger: Logger, child: ChildProcessWithoutNullStreams, signal?: AbortSignal) {
    this.logger = logger;
    this.child = child;
    this.disposeStreamParser = createCommandCodeStreamParser(child.stdout, child.stderr, {
      onFrame: (frame) => this.handleFrame(frame),
      onStderr: (text) => this.handleStderr(text),
    });
    child.on("error", (error) => {
      this.exitError = error.message;
      this.emit({ type: "exit", code: null, signal: null, error: error.message });
    });
    child.on("close", (code, signalCode) => {
      this.exited = true;
      this.capturedExitCode = code;
      this.capturedExitSignal = signalCode;
      this.emit({ type: "exit", code, signal: signalCode, error: this.exitError ?? undefined });
    });
    this.abortHandler = () => {
      void this.interrupt().catch(() => undefined);
    };
    signal?.addEventListener("abort", this.abortHandler, { once: true });
  }

  get sessionId(): string | null {
    return this.capturedSessionId;
  }

  get finalText(): string {
    return this.capturedFinalText;
  }

  get usage(): CommandCodeResultFrame["usage"] | undefined {
    return this.capturedUsage;
  }

  get stderr(): string {
    return this.capturedStderr;
  }

  get exitCode(): number | null {
    return this.capturedExitCode;
  }

  get exitSignal(): NodeJS.Signals | null {
    return this.capturedExitSignal;
  }

  hasExited(): boolean {
    return this.exited;
  }

  onEvent(callback: (event: CommandCodeRuntimeEvent) => void): () => void {
    this.subscribers.add(callback);
    return () => {
      this.subscribers.delete(callback);
    };
  }

  async interrupt(): Promise<void> {
    if (this.interruptPromise) {
      return this.interruptPromise;
    }
    this.interruptPromise = this.performInterrupt();
    return this.interruptPromise;
  }

  private async performInterrupt(): Promise<void> {
    if (this.exited || this.closed) {
      return;
    }
    await signalProcessTree(this.child, "SIGTERM");
    const forceTimer = setTimeout(() => {
      void signalProcessTree(this.child, "SIGKILL");
    }, GRACEFUL_INTERRUPT_TIMEOUT_MS);
    try {
      await new Promise((resolve) => {
        if (this.exited) {
          resolve(undefined);
          return;
        }
        const onExit = () => {
          this.child.removeListener("close", onExit);
          resolve(undefined);
        };
        this.child.once("close", onExit);
        setTimeout(() => {
          this.child.removeListener("close", onExit);
          resolve(undefined);
        }, INTERRUPT_SETTLE_TIMEOUT_MS);
      });
    } finally {
      clearTimeout(forceTimer);
    }
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.disposeStreamParser();
    if (!this.exited) {
      await this.interrupt().catch(() => undefined);
    }
  }

  private handleFrame(frame: CommandCodeFrame): void {
    if (frame.type === "result") {
      if (frame.sessionId) {
        this.capturedSessionId = frame.sessionId;
      }
      this.capturedFinalText = frame.finalText;
      if (frame.usage) {
        this.capturedUsage = frame.usage;
      }
    }
    this.emit({ type: "frame", frame });
  }

  private handleStderr(text: string): void {
    this.capturedStderr = `${this.capturedStderr}${text}\n`.slice(-STDERR_BUFFER_LIMIT);
    this.logger.debug({ text }, "Command Code stderr");
  }

  private emit(event: CommandCodeRuntimeEvent): void {
    for (const subscriber of this.subscribers) {
      subscriber(event);
    }
  }
}

export function buildCommandCodeLaunch(
  argv: string[],
  options: { cwd: string; env?: Record<string, string> },
): CommandCodeLaunch {
  return {
    cwd: options.cwd,
    argv,
    ...(options.env ? { env: options.env } : {}),
  };
}

export function nextCommandCodeTurnId(): string {
  return randomUUID();
}
