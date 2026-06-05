import { describe, expect, it } from "vitest";
import { shouldUseDocumentModel } from "../src/agentcore/modelSelection";

describe("AgentCore model selection", () => {
  it("uses the document model for direct binary inputs", () => {
    expect(
      shouldUseDocumentModel({
        content: [
          {
            type: "image",
            source: {
              type: "base64",
              media_type: "image/png",
              data: "iVBORw0KGgo=",
            },
          },
        ],
      }),
    ).toBe(true);
  });

  it("uses the document model when lazy image attachment source IDs are available", () => {
    expect(
      shouldUseDocumentModel({
        content: [{ type: "text", text: "What is in this image?" }],
        toolContext: {
          workspaceId: "line:group:G1",
          attachmentSourceIds: ["src_1"],
        },
      }),
    ).toBe(true);
  });

  it("keeps the text model for text-only requests without lazy images", () => {
    expect(
      shouldUseDocumentModel({
        content: [{ type: "text", text: "hello" }],
      }),
    ).toBe(false);
  });
});
