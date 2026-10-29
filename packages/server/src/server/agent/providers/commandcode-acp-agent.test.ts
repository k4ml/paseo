import { describe, expect, test, vi } from "vitest";

import type { ProviderCommand } from "../provider-launch-config.js";
import { createTestLogger } from "../../../test-utils/test-logger.js";
import type { SessionStateResponse, SpawnedACPProcess } from "./acp-agent.js";
import { CommandCodeACPAgentClient, COMMANDCODE_MODES } from "./commandcode-acp-agent.js";

// Captured from `cmd acp` 1.88.2: modes come from session/new, and models plus
// thinking options arrive as `model` / `thought_level` config options.
const COMMANDCODE_SESSION = {
  sessionId: "session-1",
  modes: {
    currentModeId: "default",
    availableModes: COMMANDCODE_MODES.map((mode) => ({
      id: mode.id,
      name: mode.label,
      description: mode.description ?? null,
    })),
  },
  configOptions: [
    {
      id: "model",
      name: "Model",
      category: "model",
      type: "select",
      currentValue: "deepseek/deepseek-v4-flash",
      options: [
        { value: "deepseek/deepseek-v4-flash", name: "DeepSeek V4 Flash" },
        { value: "claude-sonnet-4-6", name: "Claude Sonnet 4.6" },
      ],
    },
    {
      id: "thought_level",
      name: "Thinking",
      category: "thought_level",
      type: "select",
      currentValue: "medium",
      options: [
        { value: "low", name: "Low" },
        { value: "medium", name: "Medium" },
        { value: "high", name: "High" },
      ],
    },
  ],
} as unknown as SessionStateResponse;

class TestCommandCodeACPAgentClient extends CommandCodeACPAgentClient {
  constructor(command?: ProviderCommand) {
    super({
      logger: createTestLogger(),
      ...(command ? { runtimeSettings: { command } } : {}),
    });
  }

  protected override async spawnProcess(): Promise<SpawnedACPProcess> {
    return {
      child: { kill: vi.fn(), exitCode: 0, signalCode: null, once: vi.fn() },
      connection: { newSession: vi.fn().mockResolvedValue(COMMANDCODE_SESSION) },
      initialize: { agentCapabilities: {} },
    } as unknown as SpawnedACPProcess;
  }

  protected override async closeProbe(): Promise<void> {}

  launchCommand(): Promise<{ command: string; args: string[] }> {
    return this.resolveLaunchCommand();
  }
}

describe("CommandCodeACPAgentClient catalog", () => {
  test("derives models, thinking options, and modes from the ACP session", async () => {
    const client = new TestCommandCodeACPAgentClient();
    const catalog = await client.fetchCatalog({
      scope: "workspace",
      cwd: "/tmp/commandcode",
      force: false,
    });

    expect(catalog.modes.map((mode) => mode.id)).toEqual([
      "default",
      "auto-accept",
      "plan",
      "dont-ask",
      "bypass",
    ]);

    const flash = catalog.models.find((model) => model.id === "deepseek/deepseek-v4-flash");
    expect(flash).toMatchObject({
      provider: "commandcode",
      label: "DeepSeek V4 Flash",
      isDefault: true,
      defaultThinkingOptionId: "medium",
    });
    expect(flash?.thinkingOptions?.map((option) => option.id)).toEqual(["low", "medium", "high"]);
  });
});

describe("CommandCodeACPAgentClient launch", () => {
  test("runs the configured binary with the acp subcommand", async () => {
    const client = new TestCommandCodeACPAgentClient({
      mode: "replace",
      argv: [process.execPath],
    });

    await expect(client.launchCommand()).resolves.toEqual({
      command: process.execPath,
      args: ["acp"],
    });
  });
});
