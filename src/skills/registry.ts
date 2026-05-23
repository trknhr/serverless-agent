import { builtinSkillDefinitions } from "./builtinCatalog.generated";
import {
  BuiltinSkillDefinition,
  GeneratedSkillRecord,
  SkillDocument,
  SkillRepository,
  SkillSummary,
} from "./types";

export class SkillRegistry {
  private readonly builtinsById: Map<string, BuiltinSkillDefinition>;

  constructor(
    private readonly repository?: SkillRepository,
    builtins: BuiltinSkillDefinition[] = builtinSkillDefinitions,
  ) {
    this.builtinsById = new Map(builtins.map((skill) => [skill.skillId, skill]));
  }

  async listEnabledSummaries(workspaceId: string): Promise<SkillSummary[]> {
    const overrides = await this.listBuiltinOverrides(workspaceId);
    const builtinSummaries = [...this.builtinsById.values()]
      .filter((skill) => overrides.get(skill.skillId)?.enabled ?? skill.defaultEnabled)
      .map(toBuiltinSummary);
    const generated = await this.listGeneratedSkills(workspaceId);
    const generatedSummaries = generated
      .filter((skill) => skill.status === "enabled" && !this.builtinsById.has(skill.skillId))
      .map(toGeneratedSummary);

    return [...builtinSummaries, ...generatedSummaries].sort((a, b) => a.skillId.localeCompare(b.skillId));
  }

  async loadSkill(workspaceId: string, skillId: string): Promise<SkillDocument | null> {
    const builtin = this.builtinsById.get(skillId);
    if (builtin) {
      const override = await this.repository?.getBuiltinSkillOverride(workspaceId, skillId);
      const enabled = override?.enabled ?? builtin.defaultEnabled;
      return enabled ? toBuiltinDocument(builtin) : null;
    }

    const generated = await this.repository?.getGeneratedSkill(workspaceId, skillId);
    if (!generated || generated.status !== "enabled") {
      return null;
    }

    return toGeneratedDocument(generated);
  }

  private async listBuiltinOverrides(workspaceId: string): Promise<Map<string, { enabled: boolean }>> {
    const records = await this.repository?.listBuiltinSkillOverrides(workspaceId);
    return new Map((records ?? []).map((record) => [record.skillId, { enabled: record.enabled }]));
  }

  private async listGeneratedSkills(workspaceId: string): Promise<GeneratedSkillRecord[]> {
    return this.repository?.listGeneratedSkills(workspaceId) ?? [];
  }
}

export function formatSkillSummariesForPrompt(summaries: SkillSummary[]): string {
  if (summaries.length === 0) {
    return "";
  }

  return [
    "Available skills are listed below. They are lightweight summaries only.",
    "When a skill is relevant, call load_skill with its skill_id before following its workflow.",
    "Only load skill IDs from this list.",
    ...summaries.map((skill) => {
      const hints = skill.triggerHints.length > 0 ? ` Triggers: ${skill.triggerHints.join(", ")}.` : "";
      const tools = skill.toolAllowlist.length > 0 ? ` Tools: ${skill.toolAllowlist.join(", ")}.` : "";
      return `- ${skill.skillId}: ${skill.title}. ${skill.description}${hints}${tools}`;
    }),
  ].join("\n");
}

function toBuiltinSummary(skill: BuiltinSkillDefinition): SkillSummary {
  return {
    skillId: skill.skillId,
    source: "builtin",
    version: skill.version,
    title: skill.title,
    description: skill.description,
    triggerHints: skill.triggerHints,
    toolAllowlist: skill.toolAllowlist,
    constraints: skill.constraints,
  };
}

function toBuiltinDocument(skill: BuiltinSkillDefinition): SkillDocument {
  return {
    ...toBuiltinSummary(skill),
    body: skill.body,
  };
}

function toGeneratedSummary(skill: GeneratedSkillRecord): SkillSummary {
  return {
    skillId: skill.skillId,
    source: "generated",
    version: skill.version,
    title: skill.title,
    description: skill.description,
    triggerHints: skill.triggerHints,
    toolAllowlist: skill.toolAllowlist,
    constraints: skill.constraints,
  };
}

function toGeneratedDocument(skill: GeneratedSkillRecord): SkillDocument {
  return {
    ...toGeneratedSummary(skill),
    body: skill.body,
  };
}
