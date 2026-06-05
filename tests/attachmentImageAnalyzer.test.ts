import { describe, expect, it, vi } from "vitest";
import { ModelAttachmentImageAnalyzer } from "../src/attachments/attachmentImageAnalyzer";
import { logger } from "../src/shared/logger";

describe("ModelAttachmentImageAnalyzer", () => {
  it("sends archived image bytes as a normal user image and returns text", async () => {
    const reader = {
      readImage: vi.fn().mockResolvedValue([
        { type: "text", text: "Attached archived image: image.png" },
        {
          type: "image",
          source: {
            type: "base64",
            media_type: "image/png",
            data: "iVBORw0KGgo=",
          },
        },
      ]),
    };
    const ai = {
      generateText: vi.fn().mockResolvedValue({ text: "The image contains a school newsletter." }),
    };
    const modelProvider = vi.fn((modelId: string) => ({ modelId }));
    const analyzer = new ModelAttachmentImageAnalyzer({
      reader: reader as never,
      ai,
      modelProvider,
      modelId: "moonshotai.kimi-k2.5",
      bedrockServiceTier: "flex",
      log: logger.child({ component: "test" }),
    });

    await expect(
      analyzer.analyzeImage({
        workspaceId: "line:group:G1",
        sourceId: "src_1",
        question: "Can you read this image?",
      }),
    ).resolves.toBe("The image contains a school newsletter.");

    expect(reader.readImage).toHaveBeenCalledWith({
      workspaceId: "line:group:G1",
      sourceId: "src_1",
    });
    expect(modelProvider).toHaveBeenCalledWith("moonshotai.kimi-k2.5");
    expect(ai.generateText).toHaveBeenCalledWith(
      expect.objectContaining({
        model: { modelId: "moonshotai.kimi-k2.5" },
        providerOptions: {
          bedrock: {
            serviceTier: "flex",
          },
        },
        messages: [
          {
            role: "user",
            content: [
              expect.objectContaining({
                type: "text",
                text: expect.stringContaining("Can you read this image?"),
              }),
              {
                type: "image",
                image: "iVBORw0KGgo=",
                mediaType: "image/png",
              },
            ],
          },
        ],
      }),
    );
  });

  it("returns the reader note when no image block is available", async () => {
    const reader = {
      readImage: vi.fn().mockResolvedValue([
        { type: "text", text: "Attachment note: Archived image src_1 has expired." },
      ]),
    };
    const ai = {
      generateText: vi.fn(),
    };
    const analyzer = new ModelAttachmentImageAnalyzer({
      reader: reader as never,
      ai,
      modelProvider: vi.fn(),
      modelId: "moonshotai.kimi-k2.5",
      log: logger.child({ component: "test" }),
    });

    await expect(
      analyzer.analyzeImage({
        workspaceId: "line:group:G1",
        sourceId: "src_1",
        question: "Can you read this image?",
      }),
    ).resolves.toBe("Attachment note: Archived image src_1 has expired.");
    expect(ai.generateText).not.toHaveBeenCalled();
  });
});
