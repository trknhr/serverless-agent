import { DeleteCommand, GetCommand, PutCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import {
  ScheduledTask,
  buildLegacyScheduledTaskPk,
  buildScheduledTaskPk,
  scheduledTaskSchema,
} from "../tasks/taskDefinition";
import { documentClient } from "./documentClient";

export class TaskRepository {
  constructor(private readonly tableName: string) {}

  async get(workspaceId: string, taskId: string): Promise<ScheduledTask | null> {
    const response = await documentClient.send(
      new GetCommand({
        TableName: this.tableName,
        Key: {
          pk: buildScheduledTaskPk(workspaceId, taskId),
        },
      }),
    );

    if (response.Item) {
      return parseScheduledTaskItem(response.Item);
    }

    const legacy = await this.getLegacy(taskId);
    if (!legacy || legacy.workspaceId !== workspaceId) {
      return null;
    }
    return legacy;
  }

  async getLegacy(taskId: string): Promise<ScheduledTask | null> {
    const response = await documentClient.send(
      new GetCommand({
        TableName: this.tableName,
        Key: {
          pk: buildLegacyScheduledTaskPk(taskId),
        },
      }),
    );

    return response.Item ? parseScheduledTaskItem(response.Item) : null;
  }

  async list(input: { workspaceId: string; enabled?: boolean; limit?: number }): Promise<ScheduledTask[]> {
    const expressionAttributeNames: Record<string, string> = {
      "#workspaceId": "workspaceId",
    };
    const expressionAttributeValues: Record<string, unknown> = {
      ":workspaceId": input.workspaceId,
    };
    const filterExpressions: string[] = [];

    if (input.enabled !== undefined) {
      expressionAttributeNames["#enabled"] = "enabled";
      expressionAttributeValues[":enabled"] = input.enabled;
      filterExpressions.push("#enabled = :enabled");
    }

    const response = await documentClient.send(
      new QueryCommand({
        TableName: this.tableName,
        IndexName: "WorkspaceIndex",
        KeyConditionExpression: "#workspaceId = :workspaceId",
        FilterExpression: filterExpressions.length > 0 ? filterExpressions.join(" AND ") : undefined,
        ExpressionAttributeNames: expressionAttributeNames,
        ExpressionAttributeValues: expressionAttributeValues,
        Limit: Math.min(input.limit ?? 50, 100),
        ScanIndexForward: true,
      }),
    );

    return (response.Items ?? []).map(parseScheduledTaskItem);
  }

  async save(task: ScheduledTask): Promise<void> {
    await documentClient.send(
      new PutCommand({
        TableName: this.tableName,
        Item: {
          pk: buildScheduledTaskPk(task.workspaceId, task.taskId),
          taskId: task.taskId,
          name: task.name,
          prompt: task.prompt,
          workspaceId: task.workspaceId,
          outputChannelId: task.outputChannelId,
          outputProvider: task.outputProvider,
          outputProviderAccountId: task.outputProviderAccountId,
          outputConversationKey: task.outputConversationKey,
          enabled: task.enabled,
          scheduleName: task.scheduleName,
          scheduleGroupName: task.scheduleGroupName,
          scheduleExpression: task.scheduleExpression,
          scheduleExpressionTimezone: task.scheduleExpressionTimezone,
          createdByUserId: task.createdByUserId,
          updatedByUserId: task.updatedByUserId,
          reuseSession: task.reuseSession,
          memoryStoreId: task.memoryStoreId,
          vaultIds: task.vaultIds,
          agentIdOverride: task.agentIdOverride,
          environmentIdOverride: task.environmentIdOverride,
          createdAt: task.createdAt,
          updatedAt: task.updatedAt,
        },
      }),
    );
    await this.deleteLegacyIfOwned(task.workspaceId, task.taskId);
  }

  async delete(workspaceId: string, taskId: string): Promise<void> {
    await documentClient.send(
      new DeleteCommand({
        TableName: this.tableName,
        Key: {
          pk: buildScheduledTaskPk(workspaceId, taskId),
        },
      }),
    );
    await this.deleteLegacyIfOwned(workspaceId, taskId);
  }

  private async deleteLegacyIfOwned(workspaceId: string, taskId: string): Promise<void> {
    try {
      await documentClient.send(
        new DeleteCommand({
          TableName: this.tableName,
          Key: {
            pk: buildLegacyScheduledTaskPk(taskId),
          },
          ConditionExpression: "#workspaceId = :workspaceId",
          ExpressionAttributeNames: {
            "#workspaceId": "workspaceId",
          },
          ExpressionAttributeValues: {
            ":workspaceId": workspaceId,
          },
        }),
      );
    } catch (error) {
      if ((error as { name?: string }).name === "ConditionalCheckFailedException") {
        return;
      }
      throw error;
    }
  }
}

function parseScheduledTaskItem(item: Record<string, unknown>): ScheduledTask {
  return scheduledTaskSchema.parse({
    taskId: item.taskId,
    name: item.name,
    prompt: item.prompt,
    workspaceId: item.workspaceId,
    outputChannelId: item.outputChannelId,
    outputProvider: item.outputProvider,
    outputProviderAccountId: item.outputProviderAccountId,
    outputConversationKey: item.outputConversationKey,
    enabled: item.enabled,
    scheduleName: item.scheduleName,
    scheduleGroupName: item.scheduleGroupName,
    scheduleExpression: item.scheduleExpression,
    scheduleExpressionTimezone: item.scheduleExpressionTimezone,
    createdByUserId: item.createdByUserId,
    updatedByUserId: item.updatedByUserId,
    reuseSession: item.reuseSession ?? false,
    memoryStoreId: item.memoryStoreId,
    vaultIds: item.vaultIds,
    agentIdOverride: item.agentIdOverride,
    environmentIdOverride: item.environmentIdOverride,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  });
}
