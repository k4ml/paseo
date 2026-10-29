import type { Logger } from "pino";

import type { AgentCapabilityFlags, AgentMode } from "../agent-sdk-types.js";
import {
  checkProviderLaunchAvailable,
  resolveProviderLaunch,
  type ProviderRuntimeSettings,
} from "../provider-launch-config.js";
import { ACPAgentClient } from "./acp-agent.js";
import {
  buildBinaryDiagnosticRows,
  buildCommandResolutionDiagnosticRows,
  formatProviderDiagnostic,
  formatProviderDiagnosticError,
} from "./diagnostic-utils.js";

/**
 * Command Code exposes its ACP surface through `cmd acp`. Modes, models, and
 * thinking options are discovered at session/new: the initial response carries a
 * `model` and a thought-level config option (id `effort` on 1.88.2; the base
 * client selects by category, so the id is not contract), so no catalog resolver
 * is needed.
 */
const COMMANDCODE_CAPABILITIES: AgentCapabilityFlags = {
  supportsStreaming: true,
  supportsSessionPersistence: true,
  supportsSessionListing: true,
  supportsDynamicModes: true,
  supportsMcpServers: true,
  supportsReasoningStream: true,
  supportsToolInvocations: true,
  supportsRewindConversation: false,
  supportsRewindFiles: false,
  supportsRewindBoth: false,
};

/**
 * Permission modes Command Code reports in `session/new`. Kept in sync with the
 * manifest scaffolding in `@getpaseo/protocol/provider-manifest`.
 */
export const COMMANDCODE_MODES: AgentMode[] = [
  {
    id: "default",
    label: "Standard",
    description: "Ask before running tools that change anything.",
  },
  {
    id: "auto-accept",
    label: "Accept Edits",
    description: "Auto-accept file edits; still ask for riskier actions.",
  },
  {
    id: "plan",
    label: "Plan",
    description: "Research and plan only — no edits or commands.",
  },
  {
    id: "dont-ask",
    label: "Don't Ask",
    description: "Run without prompting, keeping the safety rails on.",
  },
  {
    id: "bypass",
    label: "Bypass Permissions",
    description: "Skip every permission check (use with care).",
    isUnattended: true,
  },
];

interface CommandCodeACPAgentClientOptions {
  logger: Logger;
  runtimeSettings?: ProviderRuntimeSettings;
}

export class CommandCodeACPAgentClient extends ACPAgentClient {
  constructor(options: CommandCodeACPAgentClientOptions) {
    super({
      provider: "commandcode",
      logger: options.logger,
      runtimeSettings: options.runtimeSettings,
      defaultCommand: ["cmd", "acp"],
      defaultModes: COMMANDCODE_MODES,
      capabilities: COMMANDCODE_CAPABILITIES,
      // Command Code publishes its slash commands with available_commands_update
      // right after session/new; wait for that first batch so listCommands()
      // does not resolve to an empty list.
      waitForInitialCommands: true,
      initialCommandsWaitTimeoutMs: 5_000,
    });
  }

  override async isAvailable(): Promise<boolean> {
    return super.isAvailable();
  }

  async getDiagnostic(): Promise<{ diagnostic: string }> {
    try {
      const launch = await resolveProviderLaunch({
        commandConfig: this.runtimeSettings?.command,
        defaultBinary: "cmd",
      });
      const availability = await checkProviderLaunchAvailable(launch);

      return {
        diagnostic: formatProviderDiagnostic("Command Code", [
          ...(await buildCommandResolutionDiagnosticRows(launch, {
            knownBinaryNames: ["cmd"],
          })),
          ...(await buildBinaryDiagnosticRows(launch, availability)),
        ]),
      };
    } catch (error) {
      return {
        diagnostic: formatProviderDiagnosticError("Command Code", error),
      };
    }
  }
}
