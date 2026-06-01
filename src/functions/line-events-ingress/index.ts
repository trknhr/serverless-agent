import type { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import { SendMessageCommand, SQSClient } from "@aws-sdk/client-sqs";
import { SecretsProvider } from "../../aws/secretsProvider";
import { loadLineIngressEnv } from "../../config/env";
import { parseLineWebhook, extractLineQueueMessages } from "../../line/parseEvent";
import { verifyLineSignature } from "../../line/verifySignature";
import { EventDedupRepository } from "../../repo/eventDedupRepository";
import { ProviderBindingRepository } from "../../repo/providerBindingRepository";
import { logger } from "../../shared/logger";

const env = loadLineIngressEnv();
const sqs = new SQSClient({});
const secretsProvider = new SecretsProvider();
const eventDedupRepository = new EventDedupRepository(env.PROCESSED_EVENTS_TABLE_NAME);
const providerBindingRepository = new ProviderBindingRepository(env.PROVIDER_BINDINGS_TABLE_NAME);

export async function handler(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  const requestId = event.requestContext.requestId;
  const log = logger.child({ requestId, component: "line-events-ingress" });
  const rawBody = decodeBody(event.body ?? "", event.isBase64Encoded);
  const channelSecret = await secretsProvider.getSecretString(env.LINE_CHANNEL_SECRET_SECRET_ID);
  const signature = event.headers["X-Line-Signature"] ?? event.headers["x-line-signature"] ?? undefined;

  if (!verifyLineSignature({ rawBody, signature, channelSecret })) {
    log.warn("LINE signature verification failed");
    return response(401, { ok: false, error: "invalid_signature" });
  }

  const webhook = parseLineWebhook(rawBody);
  const queueMessages = extractLineQueueMessages(webhook, requestId);
  let enqueuedCount = 0;
  let duplicateCount = 0;
  let disabledCount = 0;

  for (const queueMessage of queueMessages) {
    const accepted = await eventDedupRepository.markProcessed(
      queueMessage.eventId,
      env.EVENT_DEDUP_TTL_SECONDS,
    );

    if (!accepted) {
      duplicateCount += 1;
      continue;
    }

    const resolvedWorkspace = await providerBindingRepository.resolveWorkspace({
      provider: "line",
      providerAccountId: queueMessage.providerAccountId,
      providerConversationKey: `${queueMessage.responseTargetType}:${queueMessage.responseTargetId}`,
      fallbackWorkspaceId: queueMessage.workspaceId,
      resolutionMode: env.LINE_WORKSPACE_RESOLUTION_MODE,
    });

    if (!resolvedWorkspace) {
      disabledCount += 1;
      log.info("LINE event ignored because provider binding did not resolve", {
        correlationId: queueMessage.correlationId,
        responseTargetType: queueMessage.responseTargetType,
        workspaceResolutionMode: env.LINE_WORKSPACE_RESOLUTION_MODE,
      });
      continue;
    }

    const resolvedQueueMessage = {
      ...queueMessage,
      workspaceId: resolvedWorkspace.workspaceId,
    };

    await sqs.send(
      new SendMessageCommand({
        QueueUrl: env.LINE_QUEUE_URL,
        MessageBody: JSON.stringify(resolvedQueueMessage),
      }),
    );
    enqueuedCount += 1;
  }

  log.info("LINE webhook processed", {
    hasDestination: Boolean(webhook.destination),
    eventCount: webhook.events.length,
    enqueuedCount,
    duplicateCount,
    disabledCount,
  });

  return response(200, { ok: true, enqueued: enqueuedCount, duplicate: duplicateCount, disabled: disabledCount });
}

function decodeBody(body: string, isBase64Encoded: boolean | undefined): string {
  return isBase64Encoded ? Buffer.from(body, "base64").toString("utf-8") : body;
}

function response(statusCode: number, body: Record<string, unknown>): APIGatewayProxyResult {
  return {
    statusCode,
    headers: {
      "content-type": "application/json; charset=utf-8",
    },
    body: JSON.stringify(body),
  };
}
