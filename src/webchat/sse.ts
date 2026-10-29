export interface ParsedSseEvent {
  event: string;
  data: string;
}

export function formatSse(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

export function consumeSseBuffer(buffer: string): { rest: string; events: ParsedSseEvent[] } {
  const normalized = buffer.replace(/\r\n/g, "\n");
  const parts = normalized.split("\n\n");
  const rest = parts.pop() ?? "";
  const events: ParsedSseEvent[] = [];
  for (const part of parts) {
    const event = parseSseBlock(part);
    if (event) {
      events.push(event);
    }
  }
  return { rest, events };
}

export function parseSseDocument(raw: string): ParsedSseEvent[] {
  return consumeSseBuffer(`${raw}\n\n`).events;
}

function parseSseBlock(block: string): ParsedSseEvent | undefined {
  const lines = block.split("\n").map((line) => line.trimEnd());
  const event = lines
    .find((line) => line.startsWith("event:"))
    ?.slice("event:".length)
    .trim();
  const dataLines = lines
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice("data:".length).trimStart());
  if (!event || dataLines.length === 0) {
    return undefined;
  }
  return { event, data: dataLines.join("\n") };
}
