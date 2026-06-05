import type { AgentContentBlock } from "../agent/types";
import type { AgentRuntimeRequest } from "./contracts";

export function shouldUseDocumentModel(request: Pick<AgentRuntimeRequest, "content">): boolean {
  return hasModelBinaryInput(request.content);
}

function hasModelBinaryInput(blocks: AgentContentBlock[]): boolean {
  return blocks.some((block) => block.type === "image" || (block.type === "document" && block.source.type !== "text"));
}
