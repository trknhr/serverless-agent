const SAFE_URL = /^https?:\/\//i;
const LANGUAGE = /^[a-z0-9_+-]{1,32}$/i;

export function renderMarkdown(source: string): string {
  return splitFences(source)
    .map((segment) => (segment.type === "code" ? renderCode(segment.lang, segment.text) : renderText(segment.text)))
    .join("");
}

function splitFences(
  source: string,
): Array<{ type: "code"; lang: string; text: string } | { type: "text"; text: string }> {
  const parts: Array<{ type: "code"; lang: string; text: string } | { type: "text"; text: string }> = [];
  const pattern = /```([^\n`]*)\n([\s\S]*?)```/g;
  let lastIndex = 0;
  for (const match of source.matchAll(pattern)) {
    const index = match.index ?? 0;
    if (index > lastIndex) {
      parts.push({ type: "text", text: source.slice(lastIndex, index) });
    }
    parts.push({
      type: "code",
      lang: match[1]?.trim() ?? "",
      text: match[2]?.replace(/\n$/, "") ?? "",
    });
    lastIndex = index + match[0].length;
  }

  const rest = source.slice(lastIndex);
  const openFence = /```([^\n`]*)\n([\s\S]*)$/.exec(rest);
  if (openFence && openFence.index !== undefined) {
    if (openFence.index > 0) {
      parts.push({ type: "text", text: rest.slice(0, openFence.index) });
    }
    parts.push({
      type: "code",
      lang: openFence[1]?.trim() ?? "",
      text: openFence[2] ?? "",
    });
    return parts;
  }
  if (rest) {
    parts.push({ type: "text", text: rest });
  }
  return parts;
}

function renderCode(lang: string, text: string): string {
  const language = LANGUAGE.test(lang) ? ` class="language-${escapeHtml(lang)}"` : "";
  return `<pre><code${language}>${escapeHtml(text)}</code></pre>`;
}

function renderText(source: string): string {
  const trimmed = source.replace(/^\n+|\n+$/g, "");
  if (!trimmed) {
    return "";
  }
  return trimmed
    .split(/\n{2,}/)
    .map((block) => renderBlock(block))
    .join("");
}

function renderBlock(block: string): string {
  const lines = block.split("\n");
  if (lines.length > 0 && lines.every((line) => /^\s*[-*] \S/.test(line))) {
    const items = lines.map((line) => `<li>${renderInline(line.replace(/^\s*[-*] /, ""))}</li>`).join("");
    return `<ul>${items}</ul>`;
  }
  if (lines.length > 0 && lines.every((line) => /^\s*\d+\. \S/.test(line))) {
    const items = lines.map((line) => `<li>${renderInline(line.replace(/^\s*\d+\. /, ""))}</li>`).join("");
    return `<ol>${items}</ol>`;
  }
  return `<p>${lines.map((line) => renderInline(line)).join("<br />")}</p>`;
}

function renderInline(input: string): string {
  let html = "";
  let index = 0;
  while (index < input.length) {
    if (input.startsWith("`", index)) {
      const end = input.indexOf("`", index + 1);
      if (end > index + 1) {
        html += `<code>${escapeHtml(input.slice(index + 1, end))}</code>`;
        index = end + 1;
        continue;
      }
    }
    if (input.startsWith("**", index)) {
      const end = input.indexOf("**", index + 2);
      if (end > index + 2) {
        html += `<strong>${renderInline(input.slice(index + 2, end))}</strong>`;
        index = end + 2;
        continue;
      }
    }
    const link = /^\[([^\]\n]+)\]\(([^)\s]+)\)/.exec(input.slice(index));
    if (link) {
      html += renderLink(link[1] ?? "", link[2] ?? "", link[0]);
      index += link[0].length;
      continue;
    }
    const url = /^(https?:\/\/[^\s<]+)/i.exec(input.slice(index));
    if (url?.[1] && safeUrl(url[1])) {
      html += renderLink(url[1], url[1], url[1]);
      index += url[1].length;
      continue;
    }
    const next = nextSpecialIndex(input, index);
    html += escapeHtml(input.slice(index, next));
    index = next;
  }
  return html;
}

function nextSpecialIndex(input: string, index: number): number {
  const candidates = ["`", "**", "[", "http://", "https://", "HTTP://", "HTTPS://"]
    .map((token) => input.toLowerCase().indexOf(token.toLowerCase(), index + 1))
    .filter((found) => found > index);
  return candidates.length > 0 ? Math.min(...candidates) : input.length;
}

function renderLink(label: string, url: string, raw: string): string {
  const href = safeUrl(url);
  if (!href) {
    return escapeHtml(raw);
  }
  return `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${escapeHtml(label)}</a>`;
}

function safeUrl(url: string): string | undefined {
  if (!SAFE_URL.test(url.trim())) {
    return undefined;
  }
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return undefined;
    }
    return parsed.href;
  } catch {
    return undefined;
  }
}

export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
