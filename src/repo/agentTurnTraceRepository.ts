import { PutCommand, QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { AgentTurnDisplayedOutput, AgentTurnTraceRecord } from "../eval/agentTurnTrace";
import { documentClient } from "./documentClient";

function buildPk(workspaceId: string): string {
  return `WORKSPACE#${workspaceId}`;
}

function buildSk(createdAt: string, traceId: string, turnId: string): string {
  return `TRACE#${createdAt}#${traceId}#TURN#${turnId}`;
}

function buildTraceGsiPk(traceId: string): string {
  return `TRACE#${traceId}`;
}

function buildTraceGsiSk(createdAt: string, turnId: string): string {
  return `${createdAt}#TURN#${turnId}`;
}

export class AgentTurnTraceRepository {
  constructor(private readonly tableName: string) {}

  async save(record: AgentTurnTraceRecord): Promise<void> {
    await documentClient.send(
      new PutCommand({
        TableName: this.tableName,
        Item: {
          pk: buildPk(record.workspaceId),
          sk: buildSk(record.createdAt, record.traceId, record.turnId),
          gsi1pk: buildTraceGsiPk(record.traceId),
          gsi1sk: buildTraceGsiSk(record.createdAt, record.turnId),
          trace_id: record.traceId,
          turn_id: record.turnId,
          workspace_id: record.workspaceId,
          source: record.source,
          status: record.status,
          created_at: record.createdAt,
          updated_at: record.updatedAt,
          expires_at: record.expiresAt,
          model_id: record.modelId,
          bedrock_region: record.bedrockRegion,
          bedrock_service_tier: record.bedrockServiceTier,
          runtime_session_id: record.runtimeSessionId,
          user_id_hash: record.userIdHash,
          channel_id_hash: record.channelIdHash,
          conversation_id: record.conversationId,
          task_id: record.taskId,
          source_id: record.sourceId,
          input: record.input,
          output: record.output,
          model_output: record.modelOutput,
          displayed_output: record.displayedOutput,
          tool_calls: record.toolCalls,
          summary: record.summary,
          error: record.error,
          latency_ms: record.latencyMs,
        },
      }),
    );
  }

  async listRecentByWorkspace(input: {
    workspaceId: string;
    limit?: number;
  }): Promise<AgentTurnTraceRecord[]> {
    const response = await documentClient.send(
      new QueryCommand({
        TableName: this.tableName,
        KeyConditionExpression: "pk = :pk",
        ExpressionAttributeValues: {
          ":pk": buildPk(input.workspaceId),
        },
        ScanIndexForward: false,
        Limit: Math.min(Math.max(input.limit ?? 50, 1), 200),
      }),
    );

    return (response.Items ?? []).map(mapAgentTurnTrace);
  }

  async listByTraceId(input: {
    traceId: string;
    limit?: number;
  }): Promise<AgentTurnTraceRecord[]> {
    const response = await documentClient.send(
      new QueryCommand({
        TableName: this.tableName,
        IndexName: "TraceIdIndex",
        KeyConditionExpression: "gsi1pk = :gsi1pk",
        ExpressionAttributeValues: {
          ":gsi1pk": buildTraceGsiPk(input.traceId),
        },
        ScanIndexForward: true,
        Limit: Math.min(Math.max(input.limit ?? 50, 1), 200),
      }),
    );

    return (response.Items ?? []).map(mapAgentTurnTrace);
  }

  async updateDisplayedOutput(input: {
    traceId: string;
    turnId: string;
    displayedOutput: AgentTurnDisplayedOutput;
    updatedAt?: string;
  }): Promise<boolean> {
    const item = await this.findTraceItem(input.traceId, input.turnId);
    if (!item) {
      return false;
    }

    await documentClient.send(
      new UpdateCommand({
        TableName: this.tableName,
        Key: {
          pk: item.pk ?? buildPk(item.workspace_id as string),
          sk: item.sk ?? buildSk(item.created_at as string, input.traceId, input.turnId),
        },
        UpdateExpression: "SET displayed_output = :displayedOutput, updated_at = :updatedAt",
        ExpressionAttributeValues: {
          ":displayedOutput": input.displayedOutput,
          ":updatedAt": input.updatedAt ?? new Date().toISOString(),
        },
      }),
    );

    return true;
  }

  private async findTraceItem(traceId: string, turnId: string): Promise<Record<string, unknown> | undefined> {
    const response = await documentClient.send(
      new QueryCommand({
        TableName: this.tableName,
        IndexName: "TraceIdIndex",
        KeyConditionExpression: "gsi1pk = :gsi1pk",
        ExpressionAttributeValues: {
          ":gsi1pk": buildTraceGsiPk(traceId),
        },
        ScanIndexForward: true,
        Limit: 200,
      }),
    );

    return (response.Items ?? []).find((item) => item.turn_id === turnId);
  }
}

function mapAgentTurnTrace(item: Record<string, unknown>): AgentTurnTraceRecord {
  return {
    traceId: item.trace_id as string,
    turnId: item.turn_id as string,
    workspaceId: item.workspace_id as string,
    source: item.source as string,
    status: item.status as AgentTurnTraceRecord["status"],
    createdAt: item.created_at as string,
    updatedAt: item.updated_at as string,
    expiresAt: item.expires_at as number,
    modelId: item.model_id as string | undefined,
    bedrockRegion: item.bedrock_region as string | undefined,
    bedrockServiceTier: item.bedrock_service_tier as string | undefined,
    runtimeSessionId: item.runtime_session_id as string | undefined,
    userIdHash: item.user_id_hash as string | undefined,
    channelIdHash: item.channel_id_hash as string | undefined,
    conversationId: item.conversation_id as string | undefined,
    taskId: item.task_id as string | undefined,
    sourceId: item.source_id as string | undefined,
    input: item.input as AgentTurnTraceRecord["input"],
    output: item.output as AgentTurnTraceRecord["output"],
    modelOutput: item.model_output as AgentTurnTraceRecord["modelOutput"],
    displayedOutput: item.displayed_output as AgentTurnTraceRecord["displayedOutput"],
    toolCalls: item.tool_calls as AgentTurnTraceRecord["toolCalls"],
    summary: item.summary as AgentTurnTraceRecord["summary"],
    error: item.error as string | undefined,
    latencyMs: item.latency_ms as number,
  };
}
