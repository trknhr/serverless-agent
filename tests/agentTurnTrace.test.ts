import { describe, expect, it } from "vitest";
import {
  buildTraceExpiresAt,
  sanitizeTraceValue,
  summarizeAgentContentBlocks,
} from "../src/eval/agentTurnTrace";

describe("agent turn trace helpers", () => {
  it("sanitizes tool payloads while preserving ordinary string fields", () => {
    expect(
      sanitizeTraceValue({
        query: "central park",
        apiKey: "sk-secret12345678901234567890",
        nested: {
          authorization: "Bearer token",
          text: "xoxb-1234567890-secret",
        },
      }),
    ).toEqual({
      query: "central park",
      apiKey: "[redacted]",
      nested: {
        authorization: "[redacted]",
        text: "[redacted-slack-token]",
      },
    });
  });

  it("summarizes multimodal request content without storing raw base64 data", () => {
    const summary = summarizeAgentContentBlocks([
      {
        type: "text",
        text: "please read this",
      },
      {
        type: "image",
        source: {
          type: "base64",
          media_type: "image/png",
          data: "a".repeat(100),
        },
      },
    ]);

    expect(summary.text).toContain("please read this");
    expect(summary.blocks[1]).toEqual({
      type: "image",
      sourceType: "base64",
      mediaType: "image/png",
      sizeChars: 100,
    });
    expect(JSON.stringify(summary)).not.toContain("aaaaaaaaaa");
  });

  it("builds DynamoDB TTL seconds from trace creation time", () => {
    expect(buildTraceExpiresAt("2026-05-26T00:00:00.000Z")).toBe(1787529600);
    expect(buildTraceExpiresAt("2026-05-26T00:00:00.000Z", 30)).toBe(1782345600);
  });
});
