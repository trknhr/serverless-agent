export function splitTextForSlack(text: string, maxLength = 3000): string[] {
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

export function normalizeTextForSlack(text: string): string {
  return transformOutsideCode(stripModelThinking(text), (segment) =>
    segment
      .replace(/^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/gm, "*$1*")
      .replace(/^\s{0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/gm, "")
      .replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, "<$2|$1>")
      .replace(/\*\*(.+?)\*\*/gs, "*$1*")
      .replace(/__(.+?)__/gs, "_$1_")
      .replace(/~~(.+?)~~/gs, "~$1~"),
  ).trim();
}

export function stripModelThinking(text: string): string {
  return text
    .replace(/<thinking>[\s\S]*?<\/thinking>/gi, "")
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .trim();
}

function transformOutsideCode(text: string, transform: (segment: string) => string): string {
  const pattern = /```[\s\S]*?```|`[^`\n]+`/g;
  let cursor = 0;
  let result = "";

  for (const match of text.matchAll(pattern)) {
    const index = match.index ?? 0;
    result += transform(text.slice(cursor, index));
    result += match[0];
    cursor = index + match[0].length;
  }

  result += transform(text.slice(cursor));
  return result;
}
