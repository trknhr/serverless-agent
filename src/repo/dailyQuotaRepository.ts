import { UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { documentClient } from "./documentClient";

interface ConsumeDailyQuotaInput {
  workspaceId: string;
  kind: string;
  limit: number;
  now?: Date;
  ttlSeconds?: number;
}

const DEFAULT_TTL_SECONDS = 3 * 24 * 60 * 60;

export class DailyQuotaRepository {
  constructor(private readonly tableName: string) {}

  async consume(input: ConsumeDailyQuotaInput): Promise<boolean> {
    if (input.limit <= 0) {
      return true;
    }

    const now = input.now ?? new Date();
    const ttl = Math.floor(now.getTime() / 1000) + (input.ttlSeconds ?? DEFAULT_TTL_SECONDS);

    try {
      await documentClient.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: {
            pk: buildDailyQuotaPk(input.workspaceId, input.kind, now),
          },
          UpdateExpression:
            "SET #workspaceId = :workspaceId, #kind = :kind, #date = :date, #ttl = :ttl ADD #count :one",
          ConditionExpression: "attribute_not_exists(#count) OR #count < :limit",
          ExpressionAttributeNames: {
            "#workspaceId": "workspaceId",
            "#kind": "kind",
            "#date": "date",
            "#ttl": "ttl",
            "#count": "count",
          },
          ExpressionAttributeValues: {
            ":workspaceId": input.workspaceId,
            ":kind": input.kind,
            ":date": formatJstDate(now),
            ":ttl": ttl,
            ":one": 1,
            ":limit": input.limit,
          },
        }),
      );

      return true;
    } catch (error) {
      if ((error as { name?: string }).name === "ConditionalCheckFailedException") {
        return false;
      }
      throw error;
    }
  }
}

function buildDailyQuotaPk(workspaceId: string, kind: string, now: Date): string {
  return `USAGE#WORKSPACE#${workspaceId}#DATE#${formatJstDate(now)}#KIND#${kind}`;
}

function formatJstDate(now: Date): string {
  return new Date(now.getTime() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
}
