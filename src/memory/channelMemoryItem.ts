export interface ChannelMemoryItem {
  workspaceId: string;
  channelId: string;
  memoryId: string;
  dedupeKey?: string;
  text: string;
  entityKey?: string;
  attributes?: Record<string, unknown>;
  tags?: string[];
  importance?: number;
  status: "candidate" | "active" | "rejected" | "archived";
  origin: "explicit" | "inferred" | "imported";
  sourceType?: string;
  sourceRef?: string;
  createdByUserId?: string;
  createdAt: string;
  updatedAt: string;
}
