import { createInterface } from "node:readline";
import type { Readable } from "node:stream";

export interface CommandCodeEventFrame {
  type: "event";
  event: {
    type: string;
    [key: string]: unknown;
  };
}

export type CommandCodeResultSubtype = "success" | "error" | "max_turns";

export interface CommandCodeResultFrame {
  type: "result";
  subtype: CommandCodeResultSubtype;
  sessionId?: string;
  stopReason?: string;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
    [key: string]: unknown;
  };
  finalText: string;
  error?: string;
}

export type CommandCodeFrame = CommandCodeEventFrame | CommandCodeResultFrame;

export interface CommandCodeFrameHandler {
  onFrame: (frame: CommandCodeFrame) => void;
  onStderr: (text: string) => void;
}

/**
 * Consume the NDJSON stream produced by `cmd -p ... --output-format json`.
 * Event frames are emitted as they arrive; unknown frame shapes are ignored
 * so the parser stays forward-compatible with newer CLI versions.
 */
export function createCommandCodeStreamParser(
  stdout: Readable,
  stderr: Readable,
  handler: CommandCodeFrameHandler,
): () => void {
  const lineReader = createInterface({ input: stdout });
  lineReader.on("line", (line) => {
    const trimmed = line.trim();
    if (!trimmed) {
      return;
    }
    const frame = parseCommandCodeFrame(trimmed);
    if (frame) {
      handler.onFrame(frame);
    }
  });

  const stderrReader = createInterface({ input: stderr });
  stderrReader.on("line", (line) => {
    const text = line.trim();
    if (text) {
      handler.onStderr(text);
    }
  });

  return () => {
    lineReader.close();
    stderrReader.close();
  };
}

export function parseCommandCodeFrame(line: string): CommandCodeFrame | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line) as unknown;
  } catch {
    return null;
  }
  if (!isRecord(parsed)) {
    return null;
  }
  if (parsed.type === "event" && isRecord(parsed.event)) {
    return {
      type: "event",
      event: parsed.event as CommandCodeEventFrame["event"],
    };
  }
  if (parsed.type === "result") {
    const subtype = parsed.subtype;
    if (subtype !== "success" && subtype !== "error" && subtype !== "max_turns") {
      return null;
    }
    const result: CommandCodeResultFrame = {
      type: "result",
      subtype,
      finalText: typeof parsed.finalText === "string" ? parsed.finalText : "",
    };
    if (typeof parsed.sessionId === "string" && parsed.sessionId.length > 0) {
      result.sessionId = parsed.sessionId;
    }
    if (typeof parsed.stopReason === "string") {
      result.stopReason = parsed.stopReason;
    }
    if (typeof parsed.error === "string") {
      result.error = parsed.error;
    }
    if (isRecord(parsed.usage)) {
      result.usage = parsed.usage as CommandCodeResultFrame["usage"];
    }
    return result;
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
