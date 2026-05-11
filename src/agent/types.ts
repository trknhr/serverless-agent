export interface AgentContentTextBlock {
  type: "text";
  text: string;
}

export interface AgentContentImageBlock {
  type: "image";
  source:
    | {
        type: "base64";
        media_type: string;
        data: string;
      }
    | {
        type: "url";
        url: string;
      };
}

export interface AgentContentDocumentBlock {
  type: "document";
  title?: string;
  context?: string;
  source:
    | {
        type: "base64";
        media_type: string;
        data: string;
      }
    | {
        type: "text";
        media_type: "text/plain";
        data: string;
      }
    | {
        type: "url";
        url: string;
      }
    | {
        type: "file";
        file_id: string;
      };
}

export type AgentContentBlock =
  | AgentContentTextBlock
  | AgentContentImageBlock
  | AgentContentDocumentBlock;

export interface AgentToolUseEvent {
  id: string;
  type: string;
  name?: string;
  input?: Record<string, unknown>;
}

export interface ToolExecutionResult {
  content?: AgentContentBlock[];
  isError?: boolean;
}

export interface AgentRunResult {
  text: string;
  sessionId?: string;
  status: "completed";
  taskIds: string[];
  savedMemoryIds: string[];
  calendarDraftIds: string[];
}
