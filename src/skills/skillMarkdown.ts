export interface ParsedSkillMarkdown {
  skillId: string;
  description: string;
  title: string;
  body: string;
}

const FRONTMATTER_PATTERN = /^---\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)([\s\S]*)$/;
const SKILL_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,127}$/;

export function parseSkillMarkdown(markdown: string): ParsedSkillMarkdown {
  const source = markdown.trim();
  const match = FRONTMATTER_PATTERN.exec(source);
  if (!match) {
    throw new Error("Skill markdown must start with YAML frontmatter delimited by ---.");
  }

  const metadata = parseFrontmatter(match[1]);
  const skillId = metadata.name;
  const description = metadata.description;
  if (!skillId) {
    throw new Error("Skill frontmatter must include name.");
  }
  if (!SKILL_ID_PATTERN.test(skillId)) {
    throw new Error("Skill frontmatter name must be a lowercase slug using letters, numbers, and hyphens.");
  }
  if (!description) {
    throw new Error("Skill frontmatter must include description.");
  }

  const content = match[2].trim();
  if (!content) {
    throw new Error("Skill markdown body must not be empty.");
  }

  return {
    skillId,
    description,
    title: extractTitle(content) ?? titleizeSkillId(skillId),
    body: source,
  };
}

function parseFrontmatter(frontmatter: string): Record<string, string> {
  const values: Record<string, string> = {};

  for (const line of frontmatter.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const match = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(trimmed);
    if (!match) {
      throw new Error(`Unsupported skill frontmatter line: ${line}`);
    }

    values[match[1]] = parseScalar(match[2]);
  }

  return values;
}

function parseScalar(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith("\"") && trimmed.endsWith("\"")) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

function extractTitle(content: string): string | undefined {
  const match = /^#\s+(.+?)\s*$/m.exec(content);
  return match?.[1]?.trim();
}

function titleizeSkillId(skillId: string): string {
  return skillId
    .split("-")
    .filter(Boolean)
    .map((part) => part.slice(0, 1).toUpperCase() + part.slice(1))
    .join(" ");
}
