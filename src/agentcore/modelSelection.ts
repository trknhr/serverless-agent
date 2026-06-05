import type { AgentContentBlock } from "../agent/types";
import type { AgentRuntimeRequest } from "./contracts";

export function shouldUseDocumentModel(request: Pick<AgentRuntimeRequest, "content" | "toolContext">): boolean {
  return hasModelBinaryInput(request.content) || hasLazyImageAttachments(request.toolContext?.attachmentSourceIds);
}

function hasModelBinaryInput(blocks: AgentContentBlock[]): boolean {
  return blocks.some((block) => block.type === "image" || (block.type === "document" && block.source.type !== "text"));
}

function hasLazyImageAttachments(sourceIds: string[] | undefined): boolean {
  return Boolean(sourceIds?.length);
}
