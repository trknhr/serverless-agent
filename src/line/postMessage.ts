const LINE_MESSAGE_LIMIT = 5000;
const LINE_MESSAGES_PER_REQUEST_LIMIT = 5;

export class LineApiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LineApiError";
  }
}

export class LineMessagingClient {
  constructor(private readonly getChannelAccessToken: () => Promise<string>) {}

  async pushText(to: string, text: string): Promise<void> {
    await this.call("https://api.line.me/v2/bot/message/push", {
      to,
      messages: buildTextMessages(text),
    });
  }

  async replyText(replyToken: string, text: string): Promise<void> {
    await this.call("https://api.line.me/v2/bot/message/reply", {
      replyToken,
      messages: buildTextMessages(text),
    });
  }

  async downloadMessageContent(messageId: string): Promise<{ bytes: Buffer; contentType?: string }> {
    const response = await fetch(
      `https://api-data.line.me/v2/bot/message/${encodeURIComponent(messageId)}/content`,
      {
        method: "GET",
        headers: {
          authorization: `Bearer ${await this.getChannelAccessToken()}`,
        },
      },
    );

    if (!response.ok) {
      throw new LineApiError(`LINE content download failed with status ${response.status}: ${await response.text()}`);
    }

    return {
      bytes: Buffer.from(await response.arrayBuffer()),
      contentType: response.headers.get("content-type") ?? undefined,
    };
  }

  private async call(url: string, body: Record<string, unknown>): Promise<void> {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${await this.getChannelAccessToken()}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      throw new LineApiError(`LINE API call failed with status ${response.status}: ${await response.text()}`);
    }
  }
}

function buildTextMessages(text: string): Array<{ type: "text"; text: string }> {
  const allChunks = splitTextForLine(text);
  const chunks = allChunks.slice(0, LINE_MESSAGES_PER_REQUEST_LIMIT);
  return chunks.map((chunk, index) => ({
    type: "text",
    text:
      index === LINE_MESSAGES_PER_REQUEST_LIMIT - 1 && allChunks.length > LINE_MESSAGES_PER_REQUEST_LIMIT
        ? `${chunk.slice(0, LINE_MESSAGE_LIMIT - 20).trim()}\n\n[truncated]`
        : chunk,
  }));
}

export function splitTextForLine(text: string, maxLength = LINE_MESSAGE_LIMIT): string[] {
  const normalized = text.trim();
  if (normalized.length <= maxLength) {
    return [normalized];
  }

  const chunks: string[] = [];
  let cursor = 0;

  while (cursor < normalized.length) {
    const next = normalized.slice(cursor, cursor + maxLength);
    const breakIndex = next.lastIndexOf("\n\n");
    const sliceLength = breakIndex > maxLength / 2 ? breakIndex : next.length;
    chunks.push(normalized.slice(cursor, cursor + sliceLength).trim());
    cursor += sliceLength;
  }

  return chunks.filter(Boolean);
}
