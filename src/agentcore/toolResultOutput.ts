import { AgentContentBlock, ToolExecutionResult } from "../agent/types";

type ModelContentBlock =
  | {
      type: "text";
      text: string;
    }
  | {
      type: "image-data";
      data: string;
      mediaType: string;
    };

export function mapToolExecutionResultToModelOutput(result: ToolExecutionResult): Record<string, unknown> {
  if (result.isError) {
    return {
      type: "error-text",
      value: firstText(result.content) ?? "Tool execution failed.",
    };
  }

  const value = (result.content ?? []).map(mapContentBlockToModelOutput);
  return {
    type: "content",
    value: value.length > 0 ? value : [{ type: "text", text: "Tool completed without content." }],
  };
}

function firstText(content: AgentContentBlock[] | undefined): string | undefined {
  return content?.find((block) => block.type === "text")?.text;
}

function mapContentBlockToModelOutput(block: AgentContentBlock): ModelContentBlock {
  if (block.type === "text") {
    return {
      type: "text",
      text: block.text,
    };
  }

  if (block.type === "image" && block.source.type === "base64") {
    return {
      type: "image-data",
      data: block.source.data,
      mediaType: block.source.media_type,
    };
  }

  return {
    type: "text",
    text: `Attachment note: Non-image tool output ${attachmentTitle(block)} could not be sent to the model.`,
  };
}

function attachmentTitle(block: AgentContentBlock): string {
  if (block.type === "document") {
    return block.title ?? "document";
  }
  return "image";
}
