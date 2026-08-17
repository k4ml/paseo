import pino from "pino";
import { describe, expect, onTestFinished, test } from "vitest";

import type { AgentSessionConfig, AgentStreamEvent } from "../../agent-sdk-types.js";
import { buildCommandCodeArgv, CommandCodeAgentClient, COMMANDCODE_MODES } from "./agent.js";
import {
  type CommandCodeLaunch,
  type CommandCodeRuntime,
  type CommandCodeRuntimeEvent,
  type CommandCodeRuntimeSession,
} from "./runtime.js";
import type { CommandCodeFrame, CommandCodeResultFrame } from "./ndjson.js";

function createConfig(overrides: Partial<AgentSessionConfig> = {}): AgentSessionConfig {
  return {
    provider: "commandcode",
    cwd: "/tmp/paseo-commandcode-test",
    ...overrides,
  };
}

function collectEvents(session: {
  subscribe(callback: (event: AgentStreamEvent) => void): () => void;
}): AgentStreamEvent[] {
  const events: AgentStreamEvent[] = [];
  const unsubscribe = session.subscribe((event) => events.push(event));
  onTestFinished(() => unsubscribe());
  return events;
}

class FakeCommandCodeSession implements CommandCodeRuntimeSession {
  sessionId: string | null = null;
  finalText = "";
  usage: CommandCodeResultFrame["usage"] | undefined;
  stderr = "";
  exitCode: number | null = null;
  exitSignal: NodeJS.Signals | null = null;
  /** When true, the runtime never auto-emits exit; the test drives it. */
  readonly staysOpen: boolean;
  private readonly subscribers = new Set<(event: CommandCodeRuntimeEvent) => void>();
  private exited = false;
  private framesEmitted = false;
  private closed = false;
  private interruptCalls = 0;

  constructor(
    private readonly frames: CommandCodeFrame[],
    options?: { sessionId?: string; exitCode?: number; stderr?: string; staysOpen?: boolean },
  ) {
    this.sessionId = options?.sessionId ?? null;
    this.exitCode = options?.exitCode ?? null;
    this.stderr = options?.stderr ?? "";
    this.staysOpen = options?.staysOpen ?? false;
    // Mirror the real runtime: result-frame fields are captured into the session.
    const resultFrame = frames.find(
      (frame): frame is Extract<CommandCodeFrame, { type: "result" }> => frame.type === "result",
    );
    if (resultFrame) {
      this.sessionId = resultFrame.sessionId ?? this.sessionId;
      this.finalText = resultFrame.finalText;
      this.usage = resultFrame.usage;
    }
  }

  hasExited(): boolean {
    return this.exited;
  }

  onEvent(callback: (event: CommandCodeRuntimeEvent) => void): () => void {
    this.subscribers.add(callback);
    return () => this.subscribers.delete(callback);
  }

  /** Emit frames and terminate, mimicking the real child lifecycle. */
  emitFrames(): void {
    if (this.exited || this.framesEmitted) {
      return;
    }
    this.framesEmitted = true;
    for (const frame of this.frames) {
      for (const subscriber of this.subscribers) {
        subscriber({ type: "frame", frame });
      }
    }
    this.exited = true;
    for (const subscriber of this.subscribers) {
      subscriber({ type: "exit", code: this.exitCode, signal: null });
    }
  }

  async interrupt(): Promise<void> {
    this.interruptCalls += 1;
    this.exited = true;
    for (const subscriber of this.subscribers) {
      subscriber({ type: "exit", code: 130, signal: "SIGTERM" });
    }
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
  }

  get interruptCount(): number {
    return this.interruptCalls;
  }
}

class FakeCommandCodeRuntime implements CommandCodeRuntime {
  readonly launches: CommandCodeLaunch[] = [];
  private readonly sessions: FakeCommandCodeSession[] = [];
  private probeResult: string | null = null;
  private probeCalls: string[][] = [];

  constructor(
    private readonly sessionFactory: (launch: CommandCodeLaunch) => FakeCommandCodeSession,
  ) {}

  setProbeResult(output: string | null): void {
    this.probeResult = output;
  }

  get probeArgsList(): string[][] {
    return this.probeCalls;
  }

  async run(launch: CommandCodeLaunch): Promise<CommandCodeRuntimeSession> {
    this.launches.push(launch);
    const session = this.sessionFactory(launch);
    this.sessions.push(session);
    // Mimic the real child: frames stream in shortly after the agent has
    // attached its subscriber (the real child emits over time).
    if (!session.staysOpen) {
      setTimeout(() => session.emitFrames(), 5);
    }
    return session;
  }

  async probe(argv: string[], options?: { cwd?: string }): Promise<string | null> {
    this.probeCalls.push([...(options?.cwd ? [options.cwd] : []), ...argv]);
    return this.probeResult;
  }

  get sessionsList(): FakeCommandCodeSession[] {
    return this.sessions;
  }
}

function createClient(runtime: FakeCommandCodeRuntime): CommandCodeAgentClient {
  return new CommandCodeAgentClient({
    logger: pino({ level: "silent" }),
    runtime,
  });
}

describe("buildCommandCodeArgv", () => {
  test("first turn builds a fresh headless run", () => {
    const argv = buildCommandCodeArgv({
      promptText: "hello",
      model: "claude-sonnet-4-6",
      modeId: "default",
      internal: false,
    });
    expect(argv).toContain("-p");
    expect(argv).toContain("hello");
    expect(argv).toContain("--output-format");
    expect(argv).toContain("json");
    expect(argv).toContain("--model");
    expect(argv).toContain("claude-sonnet-4-6");
    expect(argv).toContain("--permission-mode");
    expect(argv).toContain("standard");
    expect(argv).not.toContain("--continue");
    expect(argv).not.toContain("--resume");
    expect(argv).not.toContain("--yolo");
  });

  test("yolo mode maps to --yolo", () => {
    const argv = buildCommandCodeArgv({
      promptText: "do it",
      modeId: "yolo",
      internal: false,
    });
    expect(argv).toContain("--yolo");
    expect(argv).not.toContain("--permission-mode");
  });

  test("auto-accept mode maps to --permission-mode auto-accept", () => {
    const argv = buildCommandCodeArgv({
      promptText: "do it",
      modeId: "auto-accept",
      internal: false,
    });
    expect(argv).toContain("--permission-mode");
    expect(argv).toContain("auto-accept");
  });

  test("plan mode maps to --permission-mode plan", () => {
    const argv = buildCommandCodeArgv({
      promptText: "do it",
      modeId: "plan",
      internal: false,
    });
    expect(argv).toContain("--permission-mode");
    expect(argv).toContain("plan");
  });

  test("a session with a native id pins it with --resume", () => {
    const argv = buildCommandCodeArgv({
      promptText: "continue",
      nativeSessionId: "native-1",
      internal: false,
    });
    expect(argv).toContain("--resume");
    expect(argv).toContain("native-1");
    expect(argv).not.toContain("--continue");
  });

  test("internal sessions pass --no-session", () => {
    const argv = buildCommandCodeArgv({
      promptText: "x",
      internal: true,
    });
    expect(argv).toContain("--no-session");
    expect(argv).not.toContain("--resume");
  });
});

describe("CommandCodeAgentClient.createSession", () => {
  test("creates a session that completes a successful turn", async () => {
    const runtime = new FakeCommandCodeRuntime((_launch) => {
      const session = new FakeCommandCodeSession(
        [
          {
            type: "event",
            event: {
              type: "tool_running",
              toolCallId: "t1",
              toolName: "read_file",
              description: "Reading the file",
            },
          },
          {
            type: "result",
            subtype: "success",
            sessionId: "native-1",
            finalText: "The answer is 42.",
            usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
          },
        ],
        { sessionId: "native-1", exitCode: 0 },
      );
      return session;
    });
    const client = createClient(runtime);
    const session = await client.createSession(createConfig());
    const events = collectEvents(session);

    const result = await session.run("what is 42?");
    expect(result.finalText).toBe("The answer is 42.");
    expect(result.sessionId).toBe(session.id);
    expect(result.usage?.inputTokens).toBe(100);

    // tool_running → tool_call timeline item; finalText → assistant_message.
    const toolCall = events.find(
      (event) => event.type === "timeline" && event.item.type === "tool_call",
    );
    expect(toolCall && toolCall.type === "timeline" ? toolCall.item.type : null).toBe("tool_call");
    const assistant = events.find(
      (event) => event.type === "timeline" && event.item.type === "assistant_message",
    );
    expect(assistant && assistant.type === "timeline" ? assistant.item.text : null).toBe(
      "The answer is 42.",
    );
    expect(events.some((event) => event.type === "turn_completed")).toBe(true);

    // After the turn, persistence carries the native session id.
    const handle = session.describePersistence();
    expect(handle?.nativeHandle).toBe("native-1");

    await session.close();
  });

  test("failed result frame fails the turn", async () => {
    const runtime = new FakeCommandCodeRuntime(
      () =>
        new FakeCommandCodeSession(
          [
            {
              type: "result",
              subtype: "error",
              error: "model error",
              finalText: "",
            },
          ],
          { exitCode: 1 },
        ),
    );
    const client = createClient(runtime);
    const session = await client.createSession(createConfig());
    const events = collectEvents(session);

    await expect(session.run("hi")).rejects.toThrow("Command Code exited with an error");
    const failed = events.find((event) => event.type === "turn_failed");
    expect(failed && failed.type === "turn_failed" ? failed.error : null).toBe(
      "Command Code exited with an error",
    );
  });

  test("exit without a result frame fails the turn with a mapped message", async () => {
    const runtime = new FakeCommandCodeRuntime(
      () => new FakeCommandCodeSession([], { exitCode: 3 }),
    );
    const client = createClient(runtime);
    const session = await client.createSession(createConfig());
    const events = collectEvents(session);

    await expect(session.run("hi")).rejects.toThrow("Command Code is not authenticated");
    const failed = events.find((event) => event.type === "turn_failed");
    expect(failed && failed.type === "turn_failed" ? failed.error : null).toBe(
      "Command Code is not authenticated",
    );
  });

  test("interrupt cancels the active turn", async () => {
    const runtime = new FakeCommandCodeRuntime(() => {
      const session = new FakeCommandCodeSession([], { staysOpen: true });
      return session;
    });
    const client = createClient(runtime);
    const session = await client.createSession(createConfig());
    const events = collectEvents(session);

    const { turnId } = await session.startTurn("hello");
    const runtimeSession = runtime.sessionsList[0];
    if (!runtimeSession) {
      throw new Error("expected a runtime session");
    }
    // Wait for the agent to attach to the runtime session before interrupting.
    await new Promise((resolve) => setTimeout(resolve, 10));
    await session.interrupt();
    expect(runtimeSession.interruptCount).toBeGreaterThanOrEqual(1);
    const canceled = events.find(
      (event) => event.type === "turn_canceled" && event.turnId === turnId,
    );
    expect(canceled).toBeDefined();
    await session.close();
  });
});

describe("CommandCodeAgentClient.resumeSession", () => {
  test("resumes with the stored native session id", async () => {
    const runtime = new FakeCommandCodeRuntime(
      () =>
        new FakeCommandCodeSession(
          [
            {
              type: "result",
              subtype: "success",
              sessionId: "native-1",
              finalText: "resumed",
            },
          ],
          { sessionId: "native-1", exitCode: 0 },
        ),
    );
    const client = createClient(runtime);
    const session = await client.resumeSession({
      provider: "commandcode",
      sessionId: "paseo-1",
      nativeHandle: "native-1",
      metadata: { cwd: "/tmp/paseo-commandcode-test" },
    });
    const events = collectEvents(session);
    await session.run("continue");
    expect(runtime.launches[0]?.argv).toContain("--resume");
    expect(runtime.launches[0]?.argv).toContain("native-1");
    expect(events.some((event) => event.type === "turn_completed")).toBe(true);
    await session.close();
  });

  test("resume without native handle starts fresh", async () => {
    const runtime = new FakeCommandCodeRuntime(
      () =>
        new FakeCommandCodeSession(
          [{ type: "result", subtype: "success", sessionId: "native-2", finalText: "ok" }],
          { sessionId: "native-2", exitCode: 0 },
        ),
    );
    const client = createClient(runtime);
    const session = await client.resumeSession({
      provider: "commandcode",
      sessionId: "paseo-2",
      metadata: { cwd: "/tmp/paseo-commandcode-test" },
    });
    await session.run("hi");
    expect(runtime.launches[0]?.argv).not.toContain("--resume");
    expect(runtime.launches[0]?.argv).not.toContain("--continue");
    await session.close();
  });
});

describe("CommandCodeAgentClient.fetchCatalog", () => {
  test("returns static models merged with discovered models", async () => {
    const runtime = new FakeCommandCodeRuntime(() => new FakeCommandCodeSession([]));
    runtime.setProbeResult("claude-sonnet-4-6\ndeepseek/deepseek-v4-pro\nmoonshotai/kimi-k2.5\n");
    const client = createClient(runtime);
    const catalog = await client.fetchCatalog({ scope: "global", force: true });

    const ids = catalog.models.map((model) => model.id);
    expect(ids).toContain("claude-sonnet-4-6");
    expect(ids).toContain("moonshotai/kimi-k2.5");
    // Discovered duplicates of static models are not re-added.
    expect(ids.filter((id) => id === "deepseek/deepseek-v4-pro")).toHaveLength(1);
    expect(catalog.modes).toHaveLength(COMMANDCODE_MODES.length);
    expect(catalog.defaultModeId).toBe("default");
  });

  test("filters human-formatted list-models output to real model ids", async () => {
    const runtime = new FakeCommandCodeRuntime(() => new FakeCommandCodeSession([]));
    runtime.setProbeResult(
      [
        "Available models  ·  55 models",
        "",
        "Open Source",
        "",
        "deepseek/deepseek-v4-pro             long-context reasoning",
        "moonshotai/kimi-k2.5                 multimodal frontend coding",
        "",
        "Anthropic",
        "",
        "claude-sonnet-4-6                    1M context",
        "",
        'Pass the full id, or just the short name after the last "/":',
        "cmd --model moonshotai/kimi-k2.5",
        "cmd --model kimi-k2.5",
        "Docs:  https://commandcode.ai/docs/reference/cli/models",
      ].join("\n"),
    );
    const client = createClient(runtime);
    const catalog = await client.fetchCatalog({ scope: "global", force: true });

    const ids = catalog.models.map((model) => model.id);
    expect(ids).toContain("deepseek/deepseek-v4-pro");
    expect(ids).toContain("moonshotai/kimi-k2.5");
    expect(ids).toContain("claude-sonnet-4-6");
    // Section headers and footer help text must not become model rows.
    expect(ids).not.toContain("Available");
    expect(ids).not.toContain("Open");
    expect(ids).not.toContain("Anthropic");
    expect(ids).not.toContain("cmd");
    expect(ids).not.toContain("Docs");
    expect(ids).not.toContain("Pass");
    // The `cmd` footer tokens must not create duplicate ids.
    expect(ids.filter((id) => id === "cmd")).toHaveLength(0);
  });

  test("falls back to static models when probe fails", async () => {
    const runtime = new FakeCommandCodeRuntime(() => new FakeCommandCodeSession([]));
    runtime.setProbeResult(null);
    const client = createClient(runtime);
    const catalog = await client.fetchCatalog({ scope: "global", force: true });
    expect(catalog.models.length).toBeGreaterThan(0);
  });
});

describe("CommandCodeAgentClient.isAvailable", () => {
  test("reports availability from the binary resolution", async () => {
    const runtime = new FakeCommandCodeRuntime(() => new FakeCommandCodeSession([]));
    const client = createClient(runtime);
    // isAvailable resolves the configured binary; with no override it checks PATH.
    await expect(client.isAvailable()).resolves.toBeTypeOf("boolean");
  });
});
