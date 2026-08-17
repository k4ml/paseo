import { randomUUID } from "node:crypto";
import type { Logger } from "pino";

import {
  type AgentCapabilityFlags,
  type AgentClient,
  type AgentLaunchContext,
  type AgentMetadata,
  type AgentMode,
  type AgentModelDefinition,
  type AgentPermissionRequest,
  type AgentPermissionResponse,
  type AgentPersistenceHandle,
  type AgentPromptInput,
  type AgentRunOptions,
  type AgentRunResult,
  type AgentRuntimeInfo,
  type AgentSession,
  type AgentSessionConfig,
  type AgentStreamEvent,
  type AgentTimelineItem,
  type AgentUsage,
  type FetchCatalogOptions,
  type ProviderCatalog,
  type ProviderRefreshContext,
} from "../../agent-sdk-types.js";
import { runProviderRefreshActivity } from "../../provider-refresh-deadline.js";
import {
  checkProviderLaunchAvailable,
  resolveProviderLaunch,
  type ProviderRuntimeSettings,
  type ResolvedProviderLaunch,
} from "../../provider-launch-config.js";
import {
  buildBinaryDiagnosticRows,
  buildCommandResolutionDiagnosticRows,
  formatProviderDiagnostic,
  formatProviderDiagnosticError,
  toDiagnosticErrorMessage,
} from "../diagnostic-utils.js";
import { appendOrReplaceGrowingAssistantMessage, runProviderTurn } from "../provider-runner.js";
import { composeSystemPromptParts } from "../../system-prompt.js";
import { renderPromptAttachmentAsText } from "../../prompt-attachments.js";
import {
  buildCommandCodeLaunch,
  CommandCodeCliRuntime,
  type CommandCodeRuntime,
  type CommandCodeRuntimeEvent,
  type CommandCodeRuntimeSession,
} from "./runtime.js";
import type { CommandCodeResultFrame } from "./ndjson.js";

export const COMMANDCODE_PROVIDER = "commandcode";

export const COMMANDCODE_MODES: AgentMode[] = [
  {
    id: "default",
    label: "Default",
    description: "Prompts for permission before edits and commands",
  },
  {
    id: "auto-accept",
    label: "Auto Accept",
    description: "Accepts file edits automatically",
  },
  {
    id: "plan",
    label: "Plan",
    description: "Read-only planning mode that avoids file edits",
  },
  {
    id: "yolo",
    label: "Yolo",
    description: "Bypasses all permission prompts",
    isUnattended: true,
  },
];

const DEFAULT_COMMANDCODE_MODEL_ID = "claude-sonnet-4-6";

/**
 * Curated subset of the Command Code model catalog. These ids are passed
 * through to `cmd --model` verbatim; `fetchCatalog` merges runtime-discovered
 * models from `cmd --list-models` on top.
 */
const COMMANDCODE_STATIC_MODELS: Array<{ id: string; label: string; description?: string }> = [
  {
    id: "claude-sonnet-4-6",
    label: "Claude Sonnet 4.6",
    description: "Balanced speed and capability",
  },
  {
    id: "claude-opus-4-7",
    label: "Claude Opus 4.7",
    description: "Most capable for demanding work",
  },
  { id: "claude-haiku-4-5-20251001", label: "Claude Haiku 4.5", description: "Fast and compact" },
  {
    id: "deepseek/deepseek-v4-pro",
    label: "DeepSeek V4 Pro",
    description: "Long-context reasoning",
  },
  { id: "deepseek/deepseek-v4-flash", label: "DeepSeek V4 Flash", description: "Fast reasoning" },
  { id: "gpt-5.5", label: "GPT-5.5", description: "Frontier general model" },
  { id: "Qwen/Qwen3.7-Max", label: "Qwen 3.7 Max", description: "Autonomous long-horizon coding" },
  { id: "google/gemini-3.7-flash", label: "Gemini 3.7 Flash", description: "Fast agentic coding" },
  { id: "xai/grok-4.6", label: "Grok 4.6", description: "Frontier coding performance" },
  { id: "xiaomi/mimo-v2.5", label: "MiMo V2.5", description: "Efficient long-context coding" },
];

const COMMANDCODE_CAPABILITIES: AgentCapabilityFlags = {
  supportsStreaming: true,
  supportsSessionPersistence: true,
  supportsDynamicModes: false,
  supportsMcpServers: false,
  supportsReasoningStream: false,
  supportsToolInvocations: false,
};

const DEFAULT_MAX_TURNS = 100;
const COMMANDCODE_EXIT_CODE_MESSAGES: Record<number, string> = {
  1: "Command Code exited with an error",
  3: "Command Code is not authenticated",
  4: "Command Code permission denied",
  5: "Command Code rate limit exceeded",
  6: "Command Code network failure",
  7: "Command Code API server error",
  8: "Command Code reached the maximum number of turns",
  9: "Command Code model produced no response",
  10: "Command Code has insufficient credits",
};

function mapCommandCodeModeToFlags(modeId: string | null | undefined): string[] {
  switch (modeId) {
    case "yolo":
      return ["--yolo"];
    case "auto-accept":
      return ["--permission-mode", "auto-accept"];
    case "plan":
      return ["--permission-mode", "plan"];
    case "default":
    default:
      return ["--permission-mode", "standard"];
  }
}

function normalizeCommandCodeModelId(model: string | null | undefined): string | undefined {
  const trimmed = model?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

function readUsage(usage: CommandCodeResultFrame["usage"] | undefined): AgentUsage | undefined {
  if (!usage) {
    return undefined;
  }
  const inputTokens = typeof usage.inputTokens === "number" ? usage.inputTokens : undefined;
  const outputTokens = typeof usage.outputTokens === "number" ? usage.outputTokens : undefined;
  const totalTokens = typeof usage.totalTokens === "number" ? usage.totalTokens : undefined;
  if (inputTokens === undefined && outputTokens === undefined && totalTokens === undefined) {
    return undefined;
  }
  return {
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
  };
}

function convertPromptInput(prompt: AgentPromptInput): string {
  if (typeof prompt === "string") {
    return prompt;
  }
  const textParts: string[] = [];
  for (const block of prompt) {
    if (block.type === "text") {
      textParts.push(block.text);
      continue;
    }
    if (block.type === "image") {
      textParts.push(
        "[Image attachment omitted: Command Code headless mode does not accept images]",
      );
      continue;
    }
    textParts.push(renderPromptAttachmentAsText(block));
  }
  return textParts.join("\n\n");
}

export function buildCommandCodeArgv(input: {
  promptText: string;
  model?: string;
  modeId?: string | null;
  maxTurns?: number;
  nativeSessionId?: string | null;
  internal: boolean;
  systemPrompt?: string;
}): string[] {
  const argv = ["-p", input.promptText, "--output-format", "json"];
  const model = normalizeCommandCodeModelId(input.model);
  if (model) {
    argv.push("--model", model);
  }
  if (input.modeId === "yolo") {
    argv.push("--yolo");
  } else {
    argv.push(...mapCommandCodeModeToFlags(input.modeId));
  }
  argv.push("--max-turns", String(input.maxTurns ?? DEFAULT_MAX_TURNS));
  argv.push("--skip-onboarding");
  if (input.systemPrompt) {
    argv.push("--config", `instruction=${input.systemPrompt}`);
  }
  if (input.internal) {
    argv.push("--no-session");
  } else if (input.nativeSessionId) {
    // Pin the exact native session. Never bare `--continue`: it resumes the
    // latest headless session in the cwd, which could belong to another agent.
    argv.push("--resume", input.nativeSessionId);
  }
  return argv;
}

const COMMANDCODE_MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*(\/|[-._][0-9])/;

/**
 * Parse `cmd --list-models` output. The CLI prints a human-formatted table
 * (section headers, description columns, footer help text), so only lines
 * whose first token looks like a model id are kept: either a vendor-qualified
 * id (`vendor/name`) or a bare kebab/dotted short name that contains a digit
 * (`kimi-k2.5`). Section headers (`Open Source`, `Google`) and footer lines
 * (`Pass the full id...`, `cmd --model ...`, `Docs: ...`) are dropped.
 */
function parseCommandCodeModelList(output: string): string[] {
  return output
    .split("\n")
    .map((line) => line.trim().split(/\s+/)[0])
    .filter((token) => token && COMMANDCODE_MODEL_ID_PATTERN.test(token));
}

function mapDiscoveredModels(ids: string[], provider: string): AgentModelDefinition[] {
  return ids.map((id) => ({
    provider,
    id,
    label: id,
  }));
}

function toAgentModes(): AgentMode[] {
  return COMMANDCODE_MODES.map((mode) => ({ ...mode }));
}

export interface CommandCodeAgentClientOptions {
  logger: Logger;
  runtimeSettings?: ProviderRuntimeSettings;
  runtime?: CommandCodeRuntime;
}

interface CommandCodePersistenceMetadata {
  cwd?: string;
  model?: string;
  modeId?: string;
}

function parsePersistenceMetadata(
  metadata: AgentMetadata | undefined,
): CommandCodePersistenceMetadata {
  if (!metadata) {
    return {};
  }
  return {
    ...(typeof metadata.cwd === "string" ? { cwd: metadata.cwd } : {}),
    ...(typeof metadata.model === "string" ? { model: metadata.model } : {}),
    ...(typeof metadata.modeId === "string" ? { modeId: metadata.modeId } : {}),
  };
}

interface CommandCodeAgentSessionOptions {
  logger: Logger;
  runtime: CommandCodeRuntime;
  runtimeSettings?: ProviderRuntimeSettings;
  config: AgentSessionConfig;
  /** Paseo-side session id (stable across turns). */
  sessionId: string;
  /** Command Code native session id (null until the first turn completes). */
  nativeSessionId?: string | null;
}

export class CommandCodeAgentSession implements AgentSession {
  readonly provider = COMMANDCODE_PROVIDER;
  readonly capabilities: AgentCapabilityFlags;

  private readonly logger: Logger;
  private readonly runtime: CommandCodeRuntime;
  private readonly runtimeSettings?: ProviderRuntimeSettings;
  private readonly config: AgentSessionConfig;
  private readonly sessionIdValue: string;
  private nativeSessionId: string | null;
  private readonly subscribers = new Set<(event: AgentStreamEvent) => void>();
  private readonly timeline: AgentTimelineItem[] = [];
  private activeTurnId: string | null = null;
  private activeRuntimeSession: CommandCodeRuntimeSession | null = null;
  private interrupted = false;
  private closed = false;

  constructor(options: CommandCodeAgentSessionOptions) {
    this.logger = options.logger;
    this.runtime = options.runtime;
    this.runtimeSettings = options.runtimeSettings;
    this.config = options.config;
    this.sessionIdValue = options.sessionId;
    this.nativeSessionId = options.nativeSessionId ?? null;
    this.capabilities = { ...COMMANDCODE_CAPABILITIES };
  }

  get id(): string | null {
    return this.sessionIdValue;
  }

  async run(prompt: AgentPromptInput, options?: AgentRunOptions): Promise<AgentRunResult> {
    return runProviderTurn({
      prompt,
      runOptions: options,
      startTurn: (p, o) => this.startTurn(p, o),
      subscribe: (callback) => this.subscribe(callback),
      getSessionId: () => this.sessionIdValue,
      reduceFinalText: appendOrReplaceGrowingAssistantMessage,
    });
  }

  async startTurn(
    prompt: AgentPromptInput,
    options?: AgentRunOptions,
  ): Promise<{ turnId: string }> {
    if (this.activeTurnId) {
      throw new Error("A Command Code turn is already active");
    }
    if (this.closed) {
      throw new Error("Command Code session is closed");
    }

    const turnId = randomUUID();
    this.activeTurnId = turnId;
    this.interrupted = false;

    const promptText = convertPromptInput(prompt);
    const systemPrompt = composeSystemPromptParts(
      this.config.systemPrompt,
      this.config.daemonAppendSystemPrompt,
    );
    const argv = buildCommandCodeArgv({
      promptText,
      model: this.config.model,
      modeId: this.config.modeId,
      nativeSessionId: this.nativeSessionId,
      internal: this.config.internal === true,
      systemPrompt,
    });
    const launch = buildCommandCodeLaunch(argv, {
      cwd: this.config.cwd,
      env: this.runtimeSettings?.env,
    });

    this.emit({
      type: "turn_started",
      provider: this.provider,
      turnId,
    });
    this.emit({
      type: "timeline",
      provider: this.provider,
      turnId,
      item: {
        type: "user_message",
        text: promptText,
        ...(options?.clientMessageId ? { clientMessageId: options.clientMessageId } : {}),
      },
    });

    void this.runTurn(turnId, launch, promptText);

    return { turnId };
  }

  private async runTurn(
    turnId: string,
    launch: ReturnType<typeof buildCommandCodeLaunch>,
    promptText: string,
  ): Promise<void> {
    let runtimeSession: CommandCodeRuntimeSession | undefined;
    try {
      runtimeSession = await this.runtime.run(launch);
      this.activeRuntimeSession = runtimeSession;
      const terminalEvent = await this.pumpRuntimeSession(runtimeSession, turnId);
      if (terminalEvent === "completed") {
        this.nativeSessionId = runtimeSession.sessionId ?? this.nativeSessionId;
        this.emit({
          type: "turn_completed",
          provider: this.provider,
          turnId,
          usage: readUsage(runtimeSession.usage),
        });
      } else if (terminalEvent === "failed") {
        if (this.interrupted) {
          this.emit({
            type: "turn_canceled",
            provider: this.provider,
            turnId,
            reason: "interrupted",
          });
        } else {
          this.emit({
            type: "turn_failed",
            provider: this.provider,
            turnId,
            error: this.describeRunFailure(runtimeSession),
          });
        }
      }
    } catch (error) {
      if (this.activeTurnId !== turnId) {
        return;
      }
      if (this.interrupted) {
        this.emit({
          type: "turn_canceled",
          provider: this.provider,
          turnId,
          reason: "interrupted",
        });
      } else {
        this.emit({
          type: "turn_failed",
          provider: this.provider,
          turnId,
          error: toDiagnosticErrorMessage(error),
        });
      }
    } finally {
      if (this.activeTurnId === turnId) {
        this.activeTurnId = null;
        this.activeRuntimeSession = null;
      }
      await runtimeSession?.close().catch(() => undefined);
      this.logger.debug(
        { turnId, promptText: promptText.slice(0, 120) },
        "Command Code turn finished",
      );
    }
  }

  /**
   * Stream runtime frames into agent stream events until the run reaches a
   * terminal state. Returns "completed" or "failed".
   */
  private async pumpRuntimeSession(
    runtimeSession: CommandCodeRuntimeSession,
    turnId: string,
  ): Promise<"completed" | "failed"> {
    return await new Promise((resolve) => {
      let settled = false;
      let terminal: "completed" | "failed" = "completed";
      const unsubscribe = runtimeSession.onEvent((event) => {
        if (settled) {
          return;
        }
        if (event.type === "frame") {
          const frame = event.frame;
          if (frame.type === "event") {
            this.handleEventFrame(frame, turnId);
            return;
          }
          if (frame.type === "result") {
            settled = true;
            if (frame.subtype === "success") {
              if (frame.finalText) {
                this.emitTimeline(turnId, { type: "assistant_message", text: frame.finalText });
              }
              terminal = "completed";
            } else {
              const message =
                frame.error ??
                (frame.subtype === "max_turns"
                  ? "Command Code reached the maximum number of turns"
                  : "Command Code run failed");
              this.emitTimeline(turnId, { type: "error", message });
              terminal = "failed";
            }
            unsubscribe();
            resolve(terminal);
            return;
          }
          return;
        }
        if (event.type === "exit" && !settled) {
          settled = true;
          terminal = "failed";
          unsubscribe();
          resolve(terminal);
        }
      });
    });
  }

  private handleEventFrame(
    frame: Extract<CommandCodeRuntimeEvent, { type: "frame" }>["frame"] & { type: "event" },
    turnId: string,
  ): void {
    const event = frame.event;
    if (!event || typeof event.type !== "string") {
      return;
    }
    if (event.type === "tool_running") {
      const toolName = typeof event.toolName === "string" ? event.toolName : "tool";
      const description =
        typeof event.description === "string" && event.description.length > 0
          ? event.description
          : `Running ${toolName}`;
      this.emitTimeline(turnId, {
        type: "tool_call",
        callId: typeof event.toolCallId === "string" ? event.toolCallId : randomUUID(),
        name: toolName,
        status: "running",
        error: null,
        detail: { type: "plain_text", text: description },
      });
    }
  }

  private emitTimeline(turnId: string, item: AgentTimelineItem): void {
    this.timeline.push(item);
    this.emit({
      type: "timeline",
      provider: this.provider,
      turnId,
      item,
    });
  }

  private describeRunFailure(runtimeSession: CommandCodeRuntimeSession): string {
    const code = runtimeSession.exitCode;
    if (code !== null && code in COMMANDCODE_EXIT_CODE_MESSAGES) {
      return COMMANDCODE_EXIT_CODE_MESSAGES[code];
    }
    const stderr = runtimeSession.stderr.trim();
    if (stderr) {
      return `Command Code failed: ${stderr.slice(0, 500)}`;
    }
    return `Command Code exited with code ${code ?? "unknown"}`;
  }

  subscribe(callback: (event: AgentStreamEvent) => void): () => void {
    this.subscribers.add(callback);
    return () => {
      this.subscribers.delete(callback);
    };
  }

  async *streamHistory(): AsyncGenerator<AgentStreamEvent> {
    for (const item of this.timeline) {
      yield {
        type: "timeline",
        provider: this.provider,
        item,
      };
    }
  }

  async getRuntimeInfo(): Promise<AgentRuntimeInfo> {
    return {
      provider: this.provider,
      sessionId: this.sessionIdValue,
      model: normalizeCommandCodeModelId(this.config.model) ?? null,
      modeId: this.config.modeId ?? null,
    };
  }

  async getAvailableModes(): Promise<AgentMode[]> {
    return toAgentModes();
  }

  async getCurrentMode(): Promise<string | null> {
    return this.config.modeId ?? null;
  }

  async setMode(modeId: string): Promise<void> {
    if (!COMMANDCODE_MODES.some((mode) => mode.id === modeId)) {
      throw new Error(`Unknown Command Code mode: ${modeId}`);
    }
    this.config.modeId = modeId;
    this.emit({
      type: "mode_changed",
      provider: this.provider,
      currentModeId: modeId,
      availableModes: toAgentModes(),
    });
  }

  getPendingPermissions(): AgentPermissionRequest[] {
    return [];
  }

  async respondToPermission(_requestId: string, _response: AgentPermissionResponse): Promise<void> {
    // Command Code handles permissions inside its own process; there are no
    // host-side permission prompts.
  }

  describePersistence(): AgentPersistenceHandle | null {
    return {
      provider: this.provider,
      sessionId: this.sessionIdValue,
      ...(this.nativeSessionId ? { nativeHandle: this.nativeSessionId } : {}),
      metadata: {
        cwd: this.config.cwd,
        ...(this.config.model ? { model: this.config.model } : {}),
        ...(this.config.modeId ? { modeId: this.config.modeId } : {}),
      },
    };
  }

  async interrupt(): Promise<void> {
    if (this.activeRuntimeSession) {
      this.interrupted = true;
      await this.activeRuntimeSession.interrupt().catch(() => undefined);
      return;
    }
    if (this.activeTurnId) {
      this.interrupted = true;
      this.activeTurnId = null;
      this.emit({
        type: "turn_canceled",
        provider: this.provider,
        reason: "interrupted",
      });
    }
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    if (this.activeRuntimeSession) {
      await this.activeRuntimeSession.close().catch(() => undefined);
      this.activeRuntimeSession = null;
    }
  }

  async setModel(modelId: string | null): Promise<void> {
    this.config.model = modelId ?? undefined;
  }

  private emit(event: AgentStreamEvent): void {
    for (const subscriber of this.subscribers) {
      subscriber(event);
    }
  }
}

export class CommandCodeAgentClient implements AgentClient {
  readonly provider = COMMANDCODE_PROVIDER;
  readonly capabilities: AgentCapabilityFlags;

  private readonly logger: Logger;
  private readonly runtimeSettings?: ProviderRuntimeSettings;
  private readonly runtime: CommandCodeRuntime;

  constructor(options: CommandCodeAgentClientOptions) {
    this.logger = options.logger;
    this.runtimeSettings = options.runtimeSettings;
    this.runtime =
      options.runtime ??
      new CommandCodeCliRuntime({
        logger: options.logger,
        runtimeSettings: options.runtimeSettings,
      });
    this.capabilities = { ...COMMANDCODE_CAPABILITIES };
  }

  async createSession(
    config: AgentSessionConfig,
    _launchContext?: AgentLaunchContext,
  ): Promise<AgentSession> {
    return new CommandCodeAgentSession({
      logger: this.logger,
      runtime: this.runtime,
      runtimeSettings: this.runtimeSettings,
      config,
      sessionId: randomUUID(),
    });
  }

  async resumeSession(
    handle: AgentPersistenceHandle,
    overrides?: Partial<AgentSessionConfig>,
    _launchContext?: AgentLaunchContext,
  ): Promise<AgentSession> {
    const metadata = parsePersistenceMetadata(handle.metadata);
    const model = overrides?.model !== undefined ? overrides.model : metadata.model;
    const modeId = overrides?.modeId !== undefined ? overrides.modeId : metadata.modeId;
    const config: AgentSessionConfig = {
      ...overrides,
      provider: this.provider,
      cwd: overrides?.cwd ?? metadata.cwd ?? process.cwd(),
      ...(model !== undefined ? { model } : {}),
      ...(modeId !== undefined ? { modeId } : {}),
      ...(overrides?.systemPrompt !== undefined ? { systemPrompt: overrides.systemPrompt } : {}),
      ...(overrides?.daemonAppendSystemPrompt !== undefined
        ? { daemonAppendSystemPrompt: overrides.daemonAppendSystemPrompt }
        : {}),
    };
    return new CommandCodeAgentSession({
      logger: this.logger,
      runtime: this.runtime,
      runtimeSettings: this.runtimeSettings,
      config,
      sessionId: handle.sessionId,
      nativeSessionId: handle.nativeHandle ?? null,
    });
  }

  async fetchCatalog(
    options: FetchCatalogOptions,
    context?: ProviderRefreshContext,
  ): Promise<ProviderCatalog> {
    const cwd = options.scope === "global" ? process.cwd() : options.cwd;
    const staticModels: AgentModelDefinition[] = COMMANDCODE_STATIC_MODELS.map((model) => {
      const entry: AgentModelDefinition = {
        provider: this.provider,
        id: model.id,
        label: model.label,
        description: model.description,
      };
      if (model.id === DEFAULT_COMMANDCODE_MODEL_ID) {
        entry.isDefault = true;
      }
      return entry;
    });
    let discoveredIds: string[] = [];
    try {
      const output = await runProviderRefreshActivity(context, "list-models", () =>
        this.runtime.probe(["--list-models"], { cwd }),
      );
      if (output) {
        discoveredIds = parseCommandCodeModelList(output);
      }
    } catch (error) {
      this.logger.debug({ err: error }, "Command Code model discovery failed");
    }
    const knownIds = new Set(staticModels.map((model) => model.id));
    const discoveredModels = mapDiscoveredModels(
      discoveredIds.filter((id) => !knownIds.has(id)),
      this.provider,
    );
    return {
      models: [...staticModels, ...discoveredModels],
      modes: toAgentModes(),
      defaultModeId: "default",
    };
  }

  async isAvailable(): Promise<boolean> {
    try {
      const launch = await this.resolveLaunch();
      const availability = await checkProviderLaunchAvailable(launch);
      return availability.available;
    } catch {
      return false;
    }
  }

  async getDiagnostic(): Promise<{ diagnostic: string }> {
    try {
      const launch = await this.resolveLaunch();
      const availability = await checkProviderLaunchAvailable(launch);
      return {
        diagnostic: formatProviderDiagnostic("Command Code", [
          ...(await buildCommandResolutionDiagnosticRows(launch, {
            knownBinaryNames: [launch.command],
          })),
          ...(await buildBinaryDiagnosticRows(launch, availability, {
            versionCommand: {
              command: launch.command,
              args: [...launch.args, "--version"],
            },
          })),
        ]),
      };
    } catch (error) {
      this.logger.debug({ err: error }, "Command Code diagnostic lookup failed");
      return {
        diagnostic: formatProviderDiagnosticError("Command Code", error),
      };
    }
  }

  private async resolveLaunch(): Promise<ResolvedProviderLaunch> {
    return resolveProviderLaunch({
      commandConfig: this.runtimeSettings?.command,
      defaultBinary: process.env.COMMANDCODE_COMMAND ?? "cmd",
    });
  }
}
