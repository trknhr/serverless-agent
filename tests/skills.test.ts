import { afterEach, describe, expect, it, vi } from "vitest";
import { CustomToolExecutor } from "../src/tools/executeCustomTool";
import { DynamoDbSkillRepository } from "../src/skills/dynamoDbSkillRepository";
import { SkillRegistry, formatSkillSummariesForPrompt } from "../src/skills/registry";
import { BuiltinSkillDefinition, SkillRepository } from "../src/skills/types";
import { logger } from "../src/shared/logger";

const { sendMock } = vi.hoisted(() => ({
  sendMock: vi.fn(),
}));

vi.mock("../src/repo/documentClient", () => ({
  documentClient: {
    send: sendMock,
  },
}));

afterEach(() => {
  sendMock.mockReset();
  vi.restoreAllMocks();
});

function commandInput(callIndex = 0): Record<string, unknown> {
  return sendMock.mock.calls[callIndex][0].input;
}

const builtinSkills: BuiltinSkillDefinition[] = [
  {
    skillId: "builtin-enabled",
    version: "0.1.0",
    title: "Builtin Enabled",
    description: "Default enabled skill.",
    defaultEnabled: true,
    triggerHints: ["enabled"],
    toolAllowlist: ["search_memories"],
    constraints: { maxToolCalls: 3 },
    body: "# Builtin Enabled\n\nUse this skill.",
  },
  {
    skillId: "builtin-disabled",
    version: "0.1.0",
    title: "Builtin Disabled",
    description: "Default disabled skill.",
    defaultEnabled: false,
    triggerHints: [],
    toolAllowlist: [],
    constraints: {},
    body: "# Builtin Disabled",
  },
];

describe("skill registry", () => {
  it("merges tenant-scoped generated skills and builtin overrides", async () => {
    const repository: SkillRepository = {
      listBuiltinSkillOverrides: vi.fn().mockResolvedValue([
        {
          workspaceId: "T1",
          skillId: "builtin-enabled",
          enabled: false,
          updatedAt: "updated",
        },
        {
          workspaceId: "T1",
          skillId: "builtin-disabled",
          enabled: true,
          updatedAt: "updated",
        },
      ]),
      getBuiltinSkillOverride: vi.fn().mockResolvedValue(null),
      listGeneratedSkills: vi.fn().mockResolvedValue([
        {
          workspaceId: "T1",
          skillId: "generated-enabled",
          status: "enabled",
          version: "1",
          title: "Generated Enabled",
          description: "Generated skill.",
          triggerHints: ["generated"],
          toolAllowlist: ["web_search"],
          constraints: {},
          body: "# Generated",
          createdAt: "created",
          updatedAt: "updated",
        },
        {
          workspaceId: "T1",
          skillId: "generated-draft",
          status: "draft",
          version: "1",
          title: "Generated Draft",
          description: "Draft skill.",
          triggerHints: [],
          toolAllowlist: [],
          constraints: {},
          body: "# Draft",
          createdAt: "created",
          updatedAt: "updated",
        },
      ]),
      getGeneratedSkill: vi.fn().mockResolvedValue(null),
    };
    const registry = new SkillRegistry(repository, builtinSkills);

    await expect(registry.listEnabledSummaries("T1")).resolves.toMatchObject([
      { skillId: "builtin-disabled", source: "builtin" },
      { skillId: "generated-enabled", source: "generated" },
    ]);
  });

  it("loads only enabled skills for the current workspace", async () => {
    const repository: SkillRepository = {
      listBuiltinSkillOverrides: vi.fn().mockResolvedValue([]),
      getBuiltinSkillOverride: vi.fn().mockImplementation(async (_workspaceId, skillId) =>
        skillId === "builtin-enabled"
          ? {
              workspaceId: "T1",
              skillId,
              enabled: false,
              updatedAt: "updated",
            }
          : null,
      ),
      listGeneratedSkills: vi.fn().mockResolvedValue([]),
      getGeneratedSkill: vi.fn().mockResolvedValue({
        workspaceId: "T1",
        skillId: "generated-enabled",
        status: "enabled",
        version: "1",
        title: "Generated Enabled",
        description: "Generated skill.",
        triggerHints: [],
        toolAllowlist: ["web_search"],
        constraints: {},
        body: "# Generated",
        createdAt: "created",
        updatedAt: "updated",
      }),
    };
    const registry = new SkillRegistry(repository, builtinSkills);

    await expect(registry.loadSkill("T1", "builtin-enabled")).resolves.toBeNull();
    await expect(registry.loadSkill("T1", "generated-enabled")).resolves.toMatchObject({
      skillId: "generated-enabled",
      source: "generated",
      body: "# Generated",
    });
  });

  it("formats progressive-disclosure skill summaries for the prompt", () => {
    expect(
      formatSkillSummariesForPrompt([
        {
          skillId: "web-research",
          source: "builtin",
          version: "0.1.0",
          title: "Web Research",
          description: "Research public web pages.",
          triggerHints: ["docs"],
          toolAllowlist: ["web_search"],
          constraints: {},
        },
      ]),
    ).toContain("call load_skill");
  });
});

describe("DynamoDB skill repository", () => {
  it("lists and stores tenant-scoped generated skills", async () => {
    const repo = new DynamoDbSkillRepository("skills");
    sendMock.mockResolvedValueOnce({
      Items: [
        {
          workspaceId: "T1",
          skillId: "daily-summary",
          status: "enabled",
          version: "1",
          title: "Daily Summary",
          description: "Summarize the day.",
          triggerHints: ["daily"],
          toolAllowlist: ["search_memories"],
          constraints: { maxToolCalls: 4 },
          body: "# Daily Summary",
          createdAt: "created",
          updatedAt: "updated",
        },
      ],
    });

    await expect(repo.listGeneratedSkills("T1")).resolves.toMatchObject([
      {
        workspaceId: "T1",
        skillId: "daily-summary",
        status: "enabled",
      },
    ]);
    expect(commandInput()).toMatchObject({
      TableName: "skills",
      KeyConditionExpression: "pk = :pk AND begins_with(sk, :sk)",
      ExpressionAttributeValues: {
        ":pk": "WORKSPACE#T1",
        ":sk": "SKILL#",
      },
    });

    sendMock.mockResolvedValueOnce({});
    await repo.putGeneratedSkill({
      workspaceId: "T1",
      skillId: "daily-summary",
      status: "enabled",
      version: "1",
      title: "Daily Summary",
      description: "Summarize the day.",
      triggerHints: ["daily"],
      toolAllowlist: ["search_memories"],
      constraints: { maxToolCalls: 4 },
      body: "# Daily Summary",
      createdAt: "created",
      updatedAt: "updated",
    });
    expect(commandInput(1)).toMatchObject({
      TableName: "skills",
      Item: {
        pk: "WORKSPACE#T1",
        sk: "SKILL#daily-summary",
        kind: "generated",
        workspaceId: "T1",
        skillId: "daily-summary",
      },
    });
  });

  it("reads and stores builtin skill overrides", async () => {
    const repo = new DynamoDbSkillRepository("skills");
    sendMock.mockResolvedValueOnce({
      Item: {
        workspaceId: "T1",
        skillId: "web-research",
        enabled: false,
        version: "0.1.0",
        config: { country: "JP" },
        updatedAt: "updated",
      },
    });

    await expect(repo.getBuiltinSkillOverride("T1", "web-research")).resolves.toMatchObject({
      workspaceId: "T1",
      skillId: "web-research",
      enabled: false,
    });
    expect(commandInput()).toMatchObject({
      TableName: "skills",
      Key: {
        pk: "WORKSPACE#T1",
        sk: "BUILTIN_SKILL#web-research",
      },
    });

    sendMock.mockResolvedValueOnce({});
    await repo.putBuiltinSkillOverride({
      workspaceId: "T1",
      skillId: "web-research",
      enabled: true,
      updatedAt: "updated",
    });
    expect(commandInput(1)).toMatchObject({
      TableName: "skills",
      Item: {
        pk: "WORKSPACE#T1",
        sk: "BUILTIN_SKILL#web-research",
        kind: "builtin_override",
        enabled: true,
      },
    });
  });
});

describe("load_skill tool", () => {
  it("loads skill instructions through the custom tool executor", async () => {
    const registry = {
      loadSkill: vi.fn().mockResolvedValue({
        skillId: "web-research",
        source: "builtin",
        version: "0.1.0",
        title: "Web Research",
        description: "Research public web pages.",
        triggerHints: ["docs"],
        toolAllowlist: ["web_search", "web_extract"],
        constraints: { maxToolCalls: 8 },
        body: "# Web Research\n\nUse web tools.",
      }),
    };
    const executor = new CustomToolExecutor(
      {} as never,
      {
        workspaceId: "T1",
        logger,
      },
      {
        skillRegistry: registry as never,
      },
    );

    const result = await executor.execute({
      id: "tool-1",
      type: "agent.tool_use",
      name: "load_skill",
      input: { skill_id: "web-research" },
    });

    expect(registry.loadSkill).toHaveBeenCalledWith("T1", "web-research");
    expect(result.isError).toBeUndefined();
    expect(result.content?.[0]).toMatchObject({
      type: "text",
    });
    expect(JSON.parse((result.content?.[0] as { text: string }).text)).toMatchObject({
      skill_id: "web-research",
      instructions: "# Web Research\n\nUse web tools.",
    });
  });
});
