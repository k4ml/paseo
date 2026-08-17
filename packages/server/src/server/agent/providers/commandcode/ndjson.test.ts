import { describe, expect, test } from "vitest";

import { parseCommandCodeFrame, type CommandCodeResultFrame } from "./ndjson.js";

describe("parseCommandCodeFrame", () => {
  test("parses an event frame", () => {
    const frame = parseCommandCodeFrame(
      '{"type":"event","event":{"type":"tool_running","toolCallId":"t1","toolName":"read_file","description":"Read file"}}',
    );
    expect(frame).toEqual({
      type: "event",
      event: {
        type: "tool_running",
        toolCallId: "t1",
        toolName: "read_file",
        description: "Read file",
      },
    });
  });

  test("parses a success result frame", () => {
    const frame = parseCommandCodeFrame(
      '{"type":"result","subtype":"success","sessionId":"abc-123","stopReason":"end_turn","usage":{"inputTokens":10,"outputTokens":5,"totalTokens":15},"finalText":"hello"}',
    ) as CommandCodeResultFrame | null;
    expect(frame).toMatchObject({
      type: "result",
      subtype: "success",
      sessionId: "abc-123",
      finalText: "hello",
    });
    expect(frame?.usage?.inputTokens).toBe(10);
  });

  test("parses an error result frame with error message", () => {
    const frame = parseCommandCodeFrame(
      '{"type":"result","subtype":"error","error":"boom","finalText":""}',
    );
    expect(frame).toMatchObject({
      type: "result",
      subtype: "error",
      error: "boom",
      finalText: "",
    });
  });

  test("parses a max_turns result frame", () => {
    const frame = parseCommandCodeFrame(
      '{"type":"result","subtype":"max_turns","finalText":"partial"}',
    );
    expect(frame).toMatchObject({
      type: "result",
      subtype: "max_turns",
      finalText: "partial",
    });
  });

  test("tolerates missing optional fields on a result frame", () => {
    const frame = parseCommandCodeFrame('{"type":"result","subtype":"success","finalText":"ok"}');
    expect(frame).toMatchObject({ type: "result", subtype: "success", finalText: "ok" });
    expect(frame && "sessionId" in frame ? frame.sessionId : undefined).toBeUndefined();
  });

  test("returns null for malformed JSON", () => {
    expect(parseCommandCodeFrame("{not json")).toBeNull();
  });

  test("returns null for unknown frame types", () => {
    expect(parseCommandCodeFrame('{"type":"mystery","data":1}')).toBeNull();
  });

  test("returns null for unknown result subtypes", () => {
    expect(parseCommandCodeFrame('{"type":"result","subtype":"weird","finalText":""}')).toBeNull();
  });

  test("returns null for non-object payloads", () => {
    expect(parseCommandCodeFrame("42")).toBeNull();
    expect(parseCommandCodeFrame('"string"')).toBeNull();
  });
});
