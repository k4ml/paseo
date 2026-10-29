import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

import type { AgentModelDefinition, AgentSession, AgentStreamEvent } from "../agent-sdk-types.js";
import { createTestLogger } from "../../../test-utils/test-logger.js";
import { CommandCodeACPAgentClient } from "./commandcode-acp-agent.js";

const runCommandCodeACPSmoke = process.env.COMMANDCODE_ACP_SMOKE === "1" ? describe : describe.skip;

const expectedModeIds = ["default", "auto-accept", "plan", "dont-ask", "bypass"];
const promptMarker = "ACP_SMOKE_OK";

interface SmokeEvidence {
  catalogModeIds: string[];
  catalogModels: Array<{
    id: string;
    label: string;
    isDefault: boolean | undefined;
    thinkingOptionIds: string[];
  }>;
  sessionModeIds: string[];
  initialModeId: string | null;
  planModeId: string | null;
  restoredModeId: string | null;
  runtimeInfo: unknown;
  commandCount: number;
  persistence: unknown;
  assistantText: string;
  timelineTypes: string[];
  turnCompleted: boolean;
  turnFailed: unknown;
  usage: unknown;
  resumeSessionId: string | null;
  resumeModeId: string | null;
  historyTimelineTypes: string[];
  historyText: string;
  error: string | null;
}

function formatError(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

function summarizeCatalogModels(models: AgentModelDefinition[]) {
  return models.map((model) => ({
    id: model.id,
    label: model.label,
    isDefault: model.isDefault,
    thinkingOptionIds: (model.thinkingOptions ?? []).map((option) => option.id),
  }));
}

function summarizeTimeline(events: AgentStreamEvent[]) {
  return {
    assistantText: events
      .filter(
        (event): event is Extract<AgentStreamEvent, { type: "timeline" }> =>
          event.type === "timeline" && event.item.type === "assistant_message",
      )
      .map((event) => (event.item as { text: string }).text)
      .join(""),
    timelineTypes: events
      .filter(
        (event): event is Extract<AgentStreamEvent, { type: "timeline" }> =>
          event.type === "timeline",
      )
      .map((event) => event.item.type),
    turnCompleted: events.some((event) => event.type === "turn_completed"),
    turnFailed: events.find((event) => event.type === "turn_failed") ?? null,
  };
}

runCommandCodeACPSmoke("real cmd acp smoke", () => {
  test("discovers catalog, drives a session, and completes a turn", async () => {
    const logger = createTestLogger();
    const client = new CommandCodeACPAgentClient({ logger });
    const cwd = await mkdtemp(join(tmpdir(), "paseo-commandcode-acp-"));
    const evidence: SmokeEvidence = {
      catalogModeIds: [],
      catalogModels: [],
      sessionModeIds: [],
      initialModeId: null,
      planModeId: null,
      restoredModeId: null,
      runtimeInfo: null,
      commandCount: 0,
      persistence: null,
      assistantText: "",
      timelineTypes: [],
      turnCompleted: false,
      turnFailed: null,
      usage: null,
      resumeSessionId: null,
      resumeModeId: null,
      historyTimelineTypes: [],
      historyText: "",
      error: null,
    };
    let session: AgentSession | null = null;
    let resumedSession: AgentSession | null = null;

    try {
      expect(await client.isAvailable()).toBe(true);

      const catalog = await client.fetchCatalog({ scope: "workspace", cwd, force: true });
      evidence.catalogModeIds = catalog.modes.map((mode) => mode.id);
      evidence.catalogModels = summarizeCatalogModels(catalog.models);

      session = await client.createSession({ provider: "commandcode", cwd, modeId: "default" });
      evidence.sessionModeIds = (await session.getAvailableModes()).map((mode) => mode.id);
      evidence.initialModeId = await session.getCurrentMode();
      evidence.runtimeInfo = await session.getRuntimeInfo();
      evidence.persistence = session.describePersistence();

      await session.setMode("plan");
      evidence.planModeId = await session.getCurrentMode();
      await session.setMode("default");
      evidence.restoredModeId = await session.getCurrentMode();

      evidence.commandCount = (await session.listCommands?.())?.length ?? 0;

      const events: AgentStreamEvent[] = [];
      session.subscribe((event) => events.push(event));
      const result = await session.run(`Reply with exactly ${promptMarker} and nothing else.`);
      const summary = summarizeTimeline(events);
      evidence.assistantText = result.finalText || summary.assistantText;
      evidence.timelineTypes = summary.timelineTypes;
      evidence.turnCompleted = summary.turnCompleted;
      evidence.turnFailed = summary.turnFailed;
      evidence.usage = result.usage ?? null;

      const handle = session.describePersistence();
      if (!handle) throw new Error("expected a persistence handle after the first turn");
      const originalSessionId = session.id;
      await session.close();
      session = null;

      resumedSession = await client.resumeSession(handle);
      evidence.resumeSessionId = resumedSession.id;
      evidence.resumeModeId = await resumedSession.getCurrentMode();
      const historyEvents: AgentStreamEvent[] = [];
      for await (const event of resumedSession.streamHistory()) {
        historyEvents.push(event);
      }
      const historySummary = summarizeTimeline(historyEvents);
      evidence.historyTimelineTypes = historySummary.timelineTypes;
      evidence.historyText = historySummary.assistantText;

      expect(evidence.catalogModeIds).toEqual(expectedModeIds);
      expect(evidence.sessionModeIds).toEqual(expectedModeIds);
      expect(evidence.catalogModels.length).toBeGreaterThan(0);
      expect(evidence.initialModeId).toBe("default");
      expect(evidence.planModeId).toBe("plan");
      expect(evidence.restoredModeId).toBe("default");
      expect(evidence.turnFailed).toBeNull();
      expect(evidence.turnCompleted).toBe(true);
      expect(evidence.assistantText).toContain(promptMarker);
      expect(evidence.resumeSessionId).toBe(originalSessionId);
      expect(evidence.resumeModeId).toBe("default");
    } catch (error) {
      evidence.error = formatError(error);
      throw error;
    } finally {
      console.log(`COMMANDCODE_ACP_SMOKE_EVIDENCE ${JSON.stringify(evidence, null, 2)}`);
      await resumedSession?.close();
      await session?.close();
      await rm(cwd, { recursive: true, force: true });
    }
  }, 180_000);
});
