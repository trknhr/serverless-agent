import { afterEach, describe, expect, it, vi } from "vitest";
import { CustomToolExecutor } from "../src/tools/executeCustomTool";
import { DynamoDbSkillRepository } from "../src/skills/dynamoDbSkillRepository";
import { SkillRegistry, formatSkillSummariesForPrompt } from "../src/skills/registry";
import { parseSkillMarkdown } from "../src/skills/skillMarkdown";
import { BuiltinSkillDefinition, SkillRepository, SkillStatus } from "../src/skills/types";
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
    toolAllowlist: ["search_context"],
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

const sampleSkillMarkdown = [
  "---",
  "name: hn-article-summarizer",
  "description: Summarize Hacker News articles for Slack.",
  "---",
  "# Hacker News Article Summarizer",
  "",
  "## Workflow",
  "",
  "1. Use web_extract on news.ycombinator.com.",
].join("\n");

describe("skill markdown", () => {
  it("parses required SKILL.md frontmatter", () => {
    expect(parseSkillMarkdown(sampleSkillMarkdown)).toMatchObject({
      skillId: "hn-article-summarizer",
      description: "Summarize Hacker News articles for Slack.",
      title: "Hacker News Article Summarizer",
      body: sampleSkillMarkdown,
    });
  });

  it("rejects missing or invalid frontmatter", () => {
    expect(() => parseSkillMarkdown("# Missing")).toThrow("frontmatter");
    expect(() =>
      parseSkillMarkdown(["---", "name: Bad_Name", "description: No", "---", "# Bad"].join("\n")),
    ).toThrow("lowercase slug");
  });
});

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
          toolAllowlist: ["search_context"],
          constraints: {},
          body: "# Generated",
          testCases: [],
          createdAt: "created",
          updatedAt: "updated",
        },
        {
          workspaceId: "T1",
          skillId: "generated-draft",
          status: "proposed",
          version: "1",
          title: "Generated Draft",
          description: "Draft skill.",
          triggerHints: [],
          toolAllowlist: [],
          constraints: {},
          body: "# Draft",
          testCases: [],
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
        toolAllowlist: ["search_context"],
        constraints: {},
        body: "# Generated",
        testCases: [],
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
          toolAllowlist: ["search_context"],
          constraints: {},
        },
      ]),
    ).toContain("call load_skill");
  });

  it("lists builtin admin summaries with default and override audit state", async () => {
    const repository: SkillRepository = {
      listBuiltinSkillOverrides: vi.fn().mockResolvedValue([
        {
          workspaceId: "T1",
          skillId: "builtin-enabled",
          enabled: false,
          updatedAt: "updated",
          updatedByUserId: "U1",
          previousEnabled: true,
        },
      ]),
      getBuiltinSkillOverride: vi.fn().mockResolvedValue(null),
      listGeneratedSkills: vi.fn().mockResolvedValue([]),
      getGeneratedSkill: vi.fn().mockResolvedValue(null),
    };
    const registry = new SkillRegistry(repository, builtinSkills);

    await expect(registry.listBuiltinSkillAdminSummaries("T1")).resolves.toMatchObject([
      {
        skillId: "builtin-disabled",
        source: "builtin",
        defaultEnabled: false,
        enabled: false,
        status: "disabled",
      },
      {
        skillId: "builtin-enabled",
        source: "builtin",
        defaultEnabled: true,
        enabled: false,
        status: "disabled",
        audit: {
          updatedAt: "updated",
          updatedByUserId: "U1",
          previousEnabled: true,
        },
      },
    ]);
  });

  it("updates builtin enablement with audit metadata", async () => {
    const repository: SkillRepository = {
      listBuiltinSkillOverrides: vi.fn().mockResolvedValue([]),
      getBuiltinSkillOverride: vi.fn().mockResolvedValue(null),
      listGeneratedSkills: vi.fn().mockResolvedValue([]),
      getGeneratedSkill: vi.fn().mockResolvedValue(null),
      putBuiltinSkillOverride: vi.fn().mockImplementation(async (record) => ({
        ...record,
        updatedAt: "updated",
      })),
    };
    const registry = new SkillRegistry(repository, builtinSkills);

    await expect(registry.setBuiltinSkillEnabled("T1", "builtin-enabled", false, "U1")).resolves.toMatchObject({
      skill: {
        skillId: "builtin-enabled",
        enabled: false,
        status: "disabled",
        defaultEnabled: true,
        audit: {
          updatedAt: "updated",
          updatedByUserId: "U1",
          previousEnabled: true,
        },
      },
      audit: {
        actorUserId: "U1",
        previousEnabled: true,
        nextEnabled: false,
        updatedAt: "updated",
      },
    });
    expect(repository.putBuiltinSkillOverride).toHaveBeenCalledWith({
      workspaceId: "T1",
      skillId: "builtin-enabled",
      enabled: false,
      version: "0.1.0",
      updatedByUserId: "U1",
      previousEnabled: true,
    });
  });

  it("rejects builtin enablement updates for unknown skills", async () => {
    const repository: SkillRepository = {
      listBuiltinSkillOverrides: vi.fn().mockResolvedValue([]),
      getBuiltinSkillOverride: vi.fn().mockResolvedValue(null),
      listGeneratedSkills: vi.fn().mockResolvedValue([]),
      getGeneratedSkill: vi.fn().mockResolvedValue(null),
      putBuiltinSkillOverride: vi.fn(),
    };
    const registry = new SkillRegistry(repository, builtinSkills);

    await expect(registry.setBuiltinSkillEnabled("T1", "not-real", true, "U1")).rejects.toThrow(
      "Built-in skill was not found: not-real",
    );
    expect(repository.putBuiltinSkillOverride).not.toHaveBeenCalled();
  });

  it("proposes, approves, lists, and disables generated skills", async () => {
    const records = new Map<string, Awaited<ReturnType<NonNullable<SkillRepository["putGeneratedSkill"]>>>>();
    const repository: SkillRepository = {
      listBuiltinSkillOverrides: vi.fn().mockResolvedValue([]),
      getBuiltinSkillOverride: vi.fn().mockResolvedValue(null),
      listGeneratedSkills: vi.fn().mockImplementation(async () => [...records.values()]),
      getGeneratedSkill: vi.fn().mockImplementation(async (_workspaceId, skillId) => records.get(skillId) ?? null),
      putGeneratedSkill: vi.fn().mockImplementation(async (record) => {
        const saved = {
          ...record,
          createdAt: record.createdAt ?? "created",
          updatedAt: "updated",
        };
        records.set(record.skillId, saved);
        return saved;
      }),
    };
    const registry = new SkillRegistry(repository, builtinSkills);

    const draft = await registry.proposeSkill("T1", {
      skillMarkdown: sampleSkillMarkdown,
      triggerHints: ["Hacker News"],
      toolAllowlist: ["web_extract"],
      evaluationNotes: "Summarize only article content.",
      testCases: [
        {
          name: "article summary",
          prompt: "Summarize this Hacker News article.",
          expectedBehavior: "Returns a short summary with source context.",
        },
      ],
      createdByUserId: "U1",
      createdFromConversationId: "C1",
    });

    expect(draft).toMatchObject({
      skillId: "hn-article-summarizer",
      status: "proposed",
      title: "Hacker News Article Summarizer",
      body: sampleSkillMarkdown,
      evaluationNotes: "Summarize only article content.",
      testCases: [
        {
          name: "article summary",
          prompt: "Summarize this Hacker News article.",
          expectedBehavior: "Returns a short summary with source context.",
        },
      ],
      createdByUserId: "U1",
      createdFromConversationId: "C1",
    });
    await expect(registry.loadSkill("T1", "hn-article-summarizer")).resolves.toBeNull();

    const approved = await registry.approveSkill("T1", "hn-article-summarizer", "U1");
    expect(approved).toMatchObject({
      status: "approved",
      approvedByUserId: "U1",
    });
    await expect(registry.loadSkill("T1", "hn-article-summarizer")).resolves.toBeNull();

    const enabled = await registry.enableSkill("T1", "hn-article-summarizer");
    expect(enabled.status).toBe("enabled");
    await expect(registry.listEnabledSummaries("T1")).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          skillId: "hn-article-summarizer",
          source: "generated",
        }),
      ]),
    );

    await expect(registry.listSkills("T1", { source: "generated" })).resolves.toMatchObject([
      {
        skillId: "hn-article-summarizer",
        status: "enabled",
        enabled: true,
      },
    ]);

    const disabled = await registry.disableSkill("T1", "hn-article-summarizer");
    expect(disabled.status).toBe("disabled");

    const archived = await registry.archiveSkill("T1", "hn-article-summarizer");
    expect(archived.status).toBe("archived");
  });

  it("rejects generated skill approval without known tools and test cases", async () => {
    const records = new Map<string, Awaited<ReturnType<NonNullable<SkillRepository["putGeneratedSkill"]>>>>();
    const repository: SkillRepository = {
      listBuiltinSkillOverrides: vi.fn().mockResolvedValue([]),
      getBuiltinSkillOverride: vi.fn().mockResolvedValue(null),
      listGeneratedSkills: vi.fn().mockImplementation(async () => [...records.values()]),
      getGeneratedSkill: vi.fn().mockImplementation(async (_workspaceId, skillId) => records.get(skillId) ?? null),
      putGeneratedSkill: vi.fn().mockImplementation(async (record) => {
        const saved = {
          ...record,
          createdAt: record.createdAt ?? "created",
          updatedAt: "updated",
        };
        records.set(record.skillId, saved);
        return saved;
      }),
    };
    const registry = new SkillRegistry(repository, builtinSkills);

    await registry.proposeSkill("T1", {
      skillMarkdown: sampleSkillMarkdown,
      toolAllowlist: ["not_a_tool"],
      testCases: [],
    });

    await expect(registry.approveSkill("T1", "hn-article-summarizer", "U1")).rejects.toThrow(
      "unknown tools: not_a_tool",
    );
  });

  it("approves only proposed generated skills", async () => {
    const records = new Map<string, Awaited<ReturnType<NonNullable<SkillRepository["putGeneratedSkill"]>>>>();
    const repository: SkillRepository = {
      listBuiltinSkillOverrides: vi.fn().mockResolvedValue([]),
      getBuiltinSkillOverride: vi.fn().mockResolvedValue(null),
      listGeneratedSkills: vi.fn().mockImplementation(async () => [...records.values()]),
      getGeneratedSkill: vi.fn().mockImplementation(async (_workspaceId, skillId) => records.get(skillId) ?? null),
      putGeneratedSkill: vi.fn().mockImplementation(async (record) => {
        const saved = {
          ...record,
          createdAt: record.createdAt ?? "created",
          updatedAt: "updated",
        };
        records.set(record.skillId, saved);
        return saved;
      }),
    };
    const registry = new SkillRegistry(repository, builtinSkills);
    const statuses: SkillStatus[] = ["approved", "enabled", "disabled", "rejected", "archived"];

    for (const status of statuses) {
      records.set("hn-article-summarizer", {
        workspaceId: "T1",
        skillId: "hn-article-summarizer",
        status,
        version: "0.1.0",
        title: "Hacker News Article Summarizer",
        description: "Summarize Hacker News articles for Slack.",
        triggerHints: [],
        toolAllowlist: ["web_extract"],
        constraints: {},
        body: sampleSkillMarkdown,
        testCases: [
          {
            name: "article summary",
            prompt: "Summarize this Hacker News article.",
            expectedBehavior: "Returns a short summary with source context.",
          },
        ],
        createdAt: "created",
        updatedAt: "updated",
      });

      await expect(registry.approveSkill("T1", "hn-article-summarizer", "U1")).rejects.toThrow(
        "must be proposed before it can be approved",
      );
      expect(records.get("hn-article-summarizer")?.status).toBe(status);
    }
  });

  it("does not disable proposed generated skills before approval", async () => {
    const records = new Map<string, Awaited<ReturnType<NonNullable<SkillRepository["putGeneratedSkill"]>>>>();
    const repository: SkillRepository = {
      listBuiltinSkillOverrides: vi.fn().mockResolvedValue([]),
      getBuiltinSkillOverride: vi.fn().mockResolvedValue(null),
      listGeneratedSkills: vi.fn().mockImplementation(async () => [...records.values()]),
      getGeneratedSkill: vi.fn().mockImplementation(async (_workspaceId, skillId) => records.get(skillId) ?? null),
      putGeneratedSkill: vi.fn().mockImplementation(async (record) => {
        const saved = {
          ...record,
          createdAt: record.createdAt ?? "created",
          updatedAt: "updated",
        };
        records.set(record.skillId, saved);
        return saved;
      }),
    };
    const registry = new SkillRegistry(repository, builtinSkills);
    await registry.proposeSkill("T1", {
      skillMarkdown: sampleSkillMarkdown,
      toolAllowlist: ["not_a_tool"],
      testCases: [],
    });

    await expect(registry.disableSkill("T1", "hn-article-summarizer")).rejects.toThrow(
      "must be enabled before it can be disabled",
    );
    await expect(registry.enableSkill("T1", "hn-article-summarizer")).rejects.toThrow(
      "must be approved or disabled before it can be enabled",
    );
    expect(records.get("hn-article-summarizer")?.status).toBe("proposed");
  });

  it("does not replace an enabled generated skill with a draft", async () => {
    const repository: SkillRepository = {
      listBuiltinSkillOverrides: vi.fn().mockResolvedValue([]),
      getBuiltinSkillOverride: vi.fn().mockResolvedValue(null),
      listGeneratedSkills: vi.fn().mockResolvedValue([]),
      getGeneratedSkill: vi.fn().mockResolvedValue({
        workspaceId: "T1",
        skillId: "hn-article-summarizer",
        status: "enabled",
        version: "0.1.0",
        title: "Hacker News Article Summarizer",
        description: "Existing skill.",
        triggerHints: [],
        toolAllowlist: [],
        constraints: {},
        body: sampleSkillMarkdown,
        testCases: [],
        createdAt: "created",
        updatedAt: "updated",
      }),
      putGeneratedSkill: vi.fn(),
    };
    const registry = new SkillRegistry(repository, builtinSkills);

    await expect(
      registry.proposeSkill("T1", {
        skillMarkdown: sampleSkillMarkdown,
      }),
    ).rejects.toThrow("already enabled");
    expect(repository.putGeneratedSkill).not.toHaveBeenCalled();
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
          toolAllowlist: ["search_context"],
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
      toolAllowlist: ["search_context"],
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

  it("normalizes legacy draft generated skills and stores generated skill metadata", async () => {
    const repo = new DynamoDbSkillRepository("skills");
    sendMock.mockResolvedValueOnce({
      Items: [
        {
          workspaceId: "T1",
          skillId: "daily-summary",
          status: "draft",
          version: "1",
          title: "Daily Summary",
          description: "Summarize the day.",
          triggerHints: ["daily"],
          toolAllowlist: ["search_context"],
          constraints: {},
          body: "# Daily Summary",
          evaluationNotes: "Use for daily summaries only.",
          testCases: [
            {
              name: "summarizes request",
              prompt: "Summarize today.",
              expectedBehavior: "Returns a concise summary.",
            },
          ],
          createdAt: "created",
          updatedAt: "updated",
        },
      ],
    });

    await expect(repo.listGeneratedSkills("T1")).resolves.toMatchObject([
      {
        skillId: "daily-summary",
        status: "proposed",
        evaluationNotes: "Use for daily summaries only.",
        testCases: [
          {
            name: "summarizes request",
            prompt: "Summarize today.",
            expectedBehavior: "Returns a concise summary.",
          },
        ],
      },
    ]);

    sendMock.mockResolvedValueOnce({});
    await repo.putGeneratedSkill({
      workspaceId: "T1",
      skillId: "daily-summary",
      status: "proposed",
      version: "1",
      title: "Daily Summary",
      description: "Summarize the day.",
      triggerHints: ["daily"],
      toolAllowlist: ["search_context"],
      constraints: {},
      body: "# Daily Summary",
      evaluationNotes: "Use for daily summaries only.",
      testCases: [
        {
          name: "summarizes request",
          prompt: "Summarize today.",
          expectedBehavior: "Returns a concise summary.",
        },
      ],
      createdAt: "created",
      updatedAt: "updated",
    });

    expect(commandInput(1)).toMatchObject({
      TableName: "skills",
      Item: {
        pk: "WORKSPACE#T1",
        sk: "SKILL#daily-summary",
        status: "proposed",
        evaluationNotes: "Use for daily summaries only.",
        testCases: [
          {
            name: "summarizes request",
            prompt: "Summarize today.",
            expectedBehavior: "Returns a concise summary.",
          },
        ],
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
        updatedByUserId: "U1",
        previousEnabled: true,
        updatedAt: "updated",
      },
    });

    await expect(repo.getBuiltinSkillOverride("T1", "web-research")).resolves.toMatchObject({
      workspaceId: "T1",
      skillId: "web-research",
      enabled: false,
      updatedByUserId: "U1",
      previousEnabled: true,
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
      updatedByUserId: "U2",
      previousEnabled: false,
      updatedAt: "updated",
    });
    expect(commandInput(1)).toMatchObject({
      TableName: "skills",
      Item: {
        pk: "WORKSPACE#T1",
        sk: "BUILTIN_SKILL#web-research",
        kind: "builtin_override",
        enabled: true,
        updatedByUserId: "U2",
        previousEnabled: false,
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
        toolAllowlist: ["search_context", "web_extract"],
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

  it("proposes a generated skill through the custom tool executor", async () => {
    const registry = {
      proposeSkill: vi.fn().mockResolvedValue({
        workspaceId: "T1",
        skillId: "hn-article-summarizer",
        status: "proposed",
        version: "0.1.0",
        title: "Hacker News Article Summarizer",
        description: "Summarize Hacker News articles for Slack.",
        triggerHints: ["Hacker News"],
        toolAllowlist: ["web_extract"],
        constraints: {},
        body: sampleSkillMarkdown,
        evaluationNotes: "Summarize only article content.",
        testCases: [
          {
            name: "article summary",
            prompt: "Summarize this article.",
            expectedBehavior: "Returns a concise article summary.",
          },
        ],
        createdFromConversationId: "C1",
        createdByUserId: "U1",
        createdAt: "created",
        updatedAt: "updated",
      }),
    };
    const executor = new CustomToolExecutor(
      {} as never,
      {
        workspaceId: "T1",
        userId: "U1",
        conversationId: "C1",
        logger,
      },
      {
        skillRegistry: registry as never,
      },
    );

    const result = await executor.execute({
      id: "tool-1",
      type: "agent.tool_use",
      name: "propose_skill",
      input: {
        skill_markdown: sampleSkillMarkdown,
        trigger_hints: ["Hacker News"],
        tool_allowlist: ["web_extract"],
        evaluation_notes: "Summarize only article content.",
        test_cases: [
          {
            name: "article summary",
            prompt: "Summarize this article.",
            expected_behavior: "Returns a concise article summary.",
          },
        ],
      },
    });

    expect(registry.proposeSkill).toHaveBeenCalledWith("T1", {
      skillMarkdown: sampleSkillMarkdown,
      triggerHints: ["Hacker News"],
      toolAllowlist: ["web_extract"],
      constraints: undefined,
      version: undefined,
      evaluationNotes: "Summarize only article content.",
      testCases: [
        {
          name: "article summary",
          prompt: "Summarize this article.",
          expectedBehavior: "Returns a concise article summary.",
        },
      ],
      createdFromConversationId: "C1",
      createdByUserId: "U1",
    });
    expect(result.isError).toBeUndefined();
    expect(JSON.parse((result.content?.[0] as { text: string }).text)).toMatchObject({
      proposed: true,
      skill: {
        skill_id: "hn-article-summarizer",
        status: "proposed",
        evaluation_notes: "Summarize only article content.",
        test_cases: [
          {
            name: "article summary",
            prompt: "Summarize this article.",
            expected_behavior: "Returns a concise article summary.",
          },
        ],
      },
    });
  });

  it("executes generated skill lifecycle tools", async () => {
    const generatedSkill = {
      workspaceId: "T1",
      skillId: "hn-article-summarizer",
      status: "enabled",
      version: "0.1.0",
      title: "Hacker News Article Summarizer",
      description: "Summarize Hacker News articles for Slack.",
      triggerHints: ["Hacker News"],
      toolAllowlist: ["web_extract"],
      constraints: {},
      body: sampleSkillMarkdown,
      testCases: [],
      createdAt: "created",
      updatedAt: "updated",
    };
    const registry = {
      enableSkill: vi.fn().mockResolvedValue(generatedSkill),
      rejectSkill: vi.fn().mockResolvedValue({ ...generatedSkill, status: "rejected" }),
      archiveSkill: vi.fn().mockResolvedValue({ ...generatedSkill, status: "archived" }),
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

    const enableResult = await executor.execute({
      id: "tool-enable",
      type: "agent.tool_use",
      name: "enable_skill",
      input: { skill_id: "hn-article-summarizer" },
    });
    expect(enableResult.isError).toBeUndefined();
    const rejectResult = await executor.execute({
      id: "tool-reject",
      type: "agent.tool_use",
      name: "reject_skill",
      input: { skill_id: "hn-article-summarizer" },
    });
    expect(rejectResult.isError).toBeUndefined();
    const archiveResult = await executor.execute({
      id: "tool-archive",
      type: "agent.tool_use",
      name: "archive_skill",
      input: { skill_id: "hn-article-summarizer" },
    });
    expect(archiveResult.isError).toBeUndefined();

    expect(registry.enableSkill).toHaveBeenCalledWith("T1", "hn-article-summarizer");
    expect(registry.rejectSkill).toHaveBeenCalledWith("T1", "hn-article-summarizer");
    expect(registry.archiveSkill).toHaveBeenCalledWith("T1", "hn-article-summarizer");
  });

  it("promotes an approved channel memory to workspace memory", async () => {
    const channelMemories = {
      get: vi.fn().mockResolvedValue({
        workspaceId: "T1",
        channelId: "C1",
        memoryId: "chanmem_1",
        text: "長男のわいわい広場は11:00までにアプリ申請する",
        entityKey: "place:waiwai",
        attributes: { source: "image" },
        tags: ["school"],
        importance: 0.8,
        status: "candidate",
        origin: "inferred",
        createdAt: "created",
        updatedAt: "updated",
      }),
    };
    const memoryItems = {
      save: vi.fn().mockResolvedValue({
        workspaceId: "T1",
        memoryId: "mem_1",
        text: "長男のわいわい広場は11:00までにアプリ申請する",
        entityKey: "place:nagao-waiwai",
        tags: ["school", "promoted"],
        attributes: {},
        importance: 0.8,
        sourceType: "channel_memory_promotion",
        sourceRef: "channel:C1/memory:chanmem_1",
        createdByUserId: "U1",
        createdAt: "created",
        updatedAt: "updated",
      }),
    };
    const executor = new CustomToolExecutor(
      {
        channelMemories,
        memoryItems,
      } as never,
      {
        workspaceId: "T1",
        channelId: "C1",
        userId: "U1",
        logger,
      },
    );

    const result = await executor.execute({
      id: "tool-1",
      type: "agent.tool_use",
      name: "promote_memory_to_workspace",
      input: {
        memory_id: "chanmem_1",
        entity_key: "place:nagao-waiwai",
      },
    });

    expect(channelMemories.get).toHaveBeenCalledWith("T1", "C1", "chanmem_1");
    expect(memoryItems.save).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "T1",
        entityKey: "place:nagao-waiwai",
        text: "長男のわいわい広場は11:00までにアプリ申請する",
        tags: ["school", "promoted"],
        sourceType: "channel_memory_promotion",
        sourceRef: "channel:C1/memory:chanmem_1",
        createdByUserId: "U1",
        attributes: expect.objectContaining({
          source: "image",
          promotedFrom: expect.objectContaining({
            scope: "channel",
            channelId: "C1",
            memoryId: "chanmem_1",
            promotedByUserId: "U1",
          }),
        }),
      }),
    );
    expect(result.isError).toBeUndefined();
    expect(JSON.parse((result.content?.[0] as { text: string }).text)).toMatchObject({
      promoted: true,
      workspace_memory: {
        memory_id: "mem_1",
      },
    });
    expect(executor.getSummary().savedMemoryIds).toEqual(["mem_1"]);
  });

  it("searches and safely patches tasks through custom tools", async () => {
    const tasks = {
      search: vi.fn().mockResolvedValue([
        {
          workspaceId: "T1",
          taskId: "task_alpha",
          title: "Alpha task",
          description: "Contains alpha search token. Preserve this detail.",
          status: "open",
          dueAt: "2026-06-05T23:59:00+09:00",
          priority: "high",
          updatedAt: "old",
        },
      ]),
      patch: vi.fn().mockResolvedValue({
        workspaceId: "T1",
        taskId: "task_alpha",
        title: "Alpha task",
        description: "Contains alpha search token.",
        status: "open",
        dueAt: "2026-06-05T23:59:00+09:00",
        priority: "high",
        updatedAt: "new",
      }),
    };
    const taskEvents = {
      save: vi.fn(),
    };
    const memoryItems = {
      search: vi.fn().mockResolvedValue([]),
    };
    const executor = new CustomToolExecutor(
      {
        memoryItems,
        tasks,
        taskEvents,
      } as never,
      {
        workspaceId: "T1",
        userId: "U1",
        logger,
      },
    );

    const searchResult = await executor.execute({
      id: "tool-search",
      type: "agent.tool_use",
      name: "search_context",
      input: { query: "alpha search token", limit: 5 },
    });
    expect(searchResult.isError).toBeUndefined();
    expect(tasks.search).toHaveBeenCalledWith({
      workspaceId: "T1",
      query: "alpha search token",
      statuses: undefined,
      dueBefore: undefined,
      limit: 5,
    });
    expect(memoryItems.search).toHaveBeenCalledWith({
      workspaceId: "T1",
      query: "alpha search token",
      entityKey: undefined,
      limit: 5,
    });
    expect(JSON.parse((searchResult.content?.[0] as { text: string }).text)).toMatchObject({
      count: 1,
      tasks: [
        {
          task_id: "task_alpha",
          description: "Contains alpha search token. Preserve this detail.",
          updated_at: "old",
        },
      ],
    });

    const patchResult = await executor.execute({
      id: "tool-patch",
      type: "agent.tool_use",
      name: "patch_task",
      input: {
        task_id: "task_alpha",
        expected_updated_at: "old",
        description: "Contains alpha search token.",
      },
    });

    expect(patchResult.isError).toBeUndefined();
    expect(tasks.patch).toHaveBeenCalledWith({
      workspaceId: "T1",
      taskId: "task_alpha",
      expectedUpdatedAt: "old",
      patch: {
        description: "Contains alpha search token.",
      },
    });
    expect(taskEvents.save).toHaveBeenCalledWith({
      taskId: "task_alpha",
      type: "updated",
      payload: expect.objectContaining({
        patched_fields: ["description"],
        expected_updated_at: "old",
      }),
    });
    expect(JSON.parse((patchResult.content?.[0] as { text: string }).text)).toMatchObject({
      saved: true,
      task_id: "task_alpha",
      description: "Contains alpha search token.",
    });
    expect(executor.getSummary().taskIds).toEqual(["task_alpha"]);
  });

  it("infers the scheduled reminder provider when updating the output conversation key", async () => {
    const scheduledTasks = {
      get: vi.fn().mockResolvedValue({
        taskId: "sched_1",
        name: "Morning Reminder",
        prompt: "Post today's reminder.",
        workspaceId: "T1",
        outputChannelId: "C1",
        outputProvider: "slack",
        outputConversationKey: "channel:C1",
        enabled: true,
        scheduleName: "serverless-agent-sched-1",
        scheduleGroupName: "default",
        scheduleExpression: "cron(0 8 * * ? *)",
        scheduleExpressionTimezone: "Asia/Tokyo",
        reuseSession: false,
        createdAt: "created",
        updatedAt: "updated",
      }),
      save: vi.fn(),
    };
    const scheduler = {
      buildScheduleName: vi.fn(),
      put: vi.fn().mockResolvedValue({
        scheduleName: "serverless-agent-sched-1",
        scheduleGroupName: "default",
        scheduleExpression: "cron(0 8 * * ? *)",
        timezone: "Asia/Tokyo",
      }),
    };
    const executor = new CustomToolExecutor(
      {
        scheduledTasks,
      } as never,
      {
        workspaceId: "T1",
        userId: "U1",
        channelId: "C1",
        logger,
      },
      {
        scheduledReminderScheduler: scheduler as never,
      },
    );

    const result = await executor.execute({
      id: "tool-1",
      type: "agent.tool_use",
      name: "update_scheduled_reminder",
      input: {
        scheduled_task_id: "sched_1",
        output_conversation_key: "group:G1",
      },
    });

    expect(result.isError).toBeUndefined();
    expect(scheduler.put).toHaveBeenCalledWith(
      expect.objectContaining({
        outputChannelId: "line:group:G1",
        outputProvider: "line",
        outputConversationKey: "group:G1",
      }),
    );
    expect(scheduledTasks.save).toHaveBeenCalledWith(
      expect.objectContaining({
        outputChannelId: "line:group:G1",
        outputProvider: "line",
        outputConversationKey: "group:G1",
      }),
    );
  });
});

describe("read_attachment_image tool", () => {
  it("reads archived attachment images through the attachment reader integration", async () => {
    const content = [
      {
        type: "text",
        text: "Archived image src_1.",
      },
      {
        type: "image",
        source: {
          type: "base64",
          media_type: "image/png",
          data: "iVBORw0KGgo=",
        },
      },
    ];
    const attachmentReader = {
      readImage: vi.fn().mockResolvedValue(content),
    };
    const executor = new CustomToolExecutor(
      {} as never,
      {
        workspaceId: "line:group:G1",
        logger,
        attachmentSourceIds: ["src_1"],
      },
      {
        attachmentReader,
      } as never,
    );

    await expect(
      executor.execute({
        id: "tool-1",
        type: "agent.tool_use",
        name: "read_attachment_image",
        input: { source_id: "src_1" },
      }),
    ).resolves.toEqual({ content });
    expect(attachmentReader.readImage).toHaveBeenCalledWith({
      workspaceId: "line:group:G1",
      sourceId: "src_1",
    });
  });

  it("returns an error when the attachment source ID is not allowed", async () => {
    const attachmentReader = {
      readImage: vi.fn(),
    };
    const executor = new CustomToolExecutor(
      {} as never,
      {
        workspaceId: "line:group:G1",
        logger,
        attachmentSourceIds: ["src_2"],
      },
      {
        attachmentReader,
      } as never,
    );

    await expect(
      executor.execute({
        id: "tool-1",
        type: "agent.tool_use",
        name: "read_attachment_image",
        input: { source_id: "src_1" },
      }),
    ).resolves.toEqual({
      isError: true,
      content: [
        {
          type: "text",
          text: "Archived attachment image is not available in the current request context.",
        },
      ],
    });
    expect(attachmentReader.readImage).not.toHaveBeenCalled();
  });

  it("returns an error when attachment source IDs are missing", async () => {
    const attachmentReader = {
      readImage: vi.fn(),
    };
    const executor = new CustomToolExecutor(
      {} as never,
      {
        workspaceId: "line:group:G1",
        logger,
      },
      {
        attachmentReader,
      } as never,
    );

    await expect(
      executor.execute({
        id: "tool-1",
        type: "agent.tool_use",
        name: "read_attachment_image",
        input: { source_id: "src_1" },
      }),
    ).resolves.toEqual({
      isError: true,
      content: [
        {
          type: "text",
          text: "Archived attachment image is not available in the current request context.",
        },
      ],
    });
    expect(attachmentReader.readImage).not.toHaveBeenCalled();
  });

  it("returns an error when an allowed attachment source has no reader integration", async () => {
    const executor = new CustomToolExecutor(
      {} as never,
      {
        workspaceId: "line:group:G1",
        logger,
        attachmentSourceIds: ["src_1"],
      },
    );

    await expect(
      executor.execute({
        id: "tool-1",
        type: "agent.tool_use",
        name: "read_attachment_image",
        input: { source_id: "src_1" },
      }),
    ).resolves.toEqual({
      isError: true,
      content: [
        {
          type: "text",
          text: "Archived attachment image reader is not available for this request.",
        },
      ],
    });
  });
});
