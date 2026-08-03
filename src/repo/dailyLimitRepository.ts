import { UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { documentClient } from "./documentClient";

interface ConsumeUsageLimitInput {
  workspaceId: string;
  kind: string;
  limit: number;
  period?: "day" | "month";
  now?: Date;
  ttlSeconds?: number;
}

const DEFAULT_TTL_SECONDS = 3 * 24 * 60 * 60;

export class DailyLimitRepository {
  constructor(private readonly tableName: string) {}

  async consume(input: ConsumeUsageLimitInput): Promise<boolean> {
    if (input.limit <= 0) {
      return true;
    }

    const now = input.now ?? new Date();
    const period = input.period ?? "day";
    const bucket = formatUsageBucket(now, period);
    const ttl = usageLimitTtl(now, period, input.ttlSeconds ?? DEFAULT_TTL_SECONDS);

    try {
      await documentClient.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: {
            pk: buildUsageLimitPk(input.workspaceId, input.kind, bucket),
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
            ":date": bucket,
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

function buildUsageLimitPk(workspaceId: string, kind: string, bucket: string): string {
  return `USAGE#WORKSPACE#${workspaceId}#DATE#${bucket}#KIND#${kind}`;
}

function formatUsageBucket(now: Date, period: "day" | "month"): string {
  const date = formatJstDate(now);
  return period === "month" ? date.slice(0, 7) : date;
}

function usageLimitTtl(now: Date, period: "day" | "month", ttlSeconds: number): number {
  const defaultTtl = Math.floor(now.getTime() / 1000) + ttlSeconds;
  if (period !== "month") {
    return defaultTtl;
  }

  const jst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  const retainUntil = Math.floor(
    Date.UTC(jst.getUTCFullYear(), jst.getUTCMonth() + 1, 7, 15, 0, 0) / 1000,
  );
  return Math.max(defaultTtl, retainUntil);
}

function formatJstDate(now: Date): string {
  return new Date(now.getTime() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
}
