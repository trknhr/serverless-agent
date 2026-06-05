import { AgentContentBlock } from "../agent/types";
import { BedrockServiceTier } from "../agentcore/runAgentTurn";
import { logger } from "../shared/logger";
import { ArchivedAttachmentImageReader } from "./attachmentImageReader";

interface ImageAnalysisAi {
  generateText(options: unknown): Promise<{ text: string }>;
}

type ModelProvider = (modelId: string) => unknown;
type Base64ImageBlock = Extract<AgentContentBlock, { type: "image" }> & {
  source: {
    type: "base64";
    media_type: string;
    data: string;
  };
};

export interface AttachmentImageAnalyzer {
  analyzeImage(input: {
    workspaceId: string;
    sourceId: string;
    question: string;
  }): Promise<string>;
}

export class ModelAttachmentImageAnalyzer implements AttachmentImageAnalyzer {
  constructor(
    private readonly input: {
      reader: ArchivedAttachmentImageReader;
      ai: ImageAnalysisAi;
      modelProvider: ModelProvider;
      modelId: string;
      bedrockServiceTier?: BedrockServiceTier;
      log: ReturnType<typeof logger.child>;
    },
  ) {}

  async analyzeImage(input: {
    workspaceId: string;
    sourceId: string;
    question: string;
  }): Promise<string> {
    const blocks = await this.input.reader.readImage({
      workspaceId: input.workspaceId,
      sourceId: input.sourceId,
    });
    const image = findBase64Image(blocks);
    if (!image) {
      return firstText(blocks) ?? `Archived image ${input.sourceId} could not be read.`;
    }

    const result = await this.input.ai.generateText({
      model: this.input.modelProvider(this.input.modelId),
      system:
        "You answer questions about a single user-provided image. Use only the image content. " +
        "If text is visible, transcribe it as accurately as possible. If the image is unreadable, say so.",
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: buildImageQuestion(input.question),
            },
            {
              type: "image",
              image: image.source.data,
              mediaType: image.source.media_type,
            },
          ],
        },
      ],
      ...(this.input.bedrockServiceTier
        ? {
            providerOptions: {
              bedrock: {
                serviceTier: this.input.bedrockServiceTier,
              },
            },
          }
        : {}),
    });

    const text = result.text.trim();
    if (!text) {
      this.input.log.warn("Attachment image analyzer returned empty text", {
        sourceId: input.sourceId,
        modelId: this.input.modelId,
      });
      return "The image was analyzed, but no readable content was returned.";
    }
    return text;
  }
}

function findBase64Image(blocks: AgentContentBlock[]): Base64ImageBlock | undefined {
  return blocks.find(
    (block): block is Base64ImageBlock =>
      block.type === "image" && block.source.type === "base64",
  );
}

function firstText(blocks: AgentContentBlock[]): string | undefined {
  return blocks.find((block) => block.type === "text")?.text;
}

function buildImageQuestion(question: string): string {
  const trimmed = question.trim();
  if (trimmed) {
    return [
      "Answer the following question about the attached image.",
      "Do not rely on outside context except the question text.",
      `Question: ${trimmed}`,
    ].join("\n");
  }

  return "Describe the attached image and transcribe any visible text.";
}
