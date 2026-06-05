import { describe, expect, it } from "vitest";
import { customToolDefinitions } from "../src/tools/definitions";

function toolDescription(name: string): string {
  const definition = customToolDefinitions.find((tool) => tool.name === name);
  if (!definition) {
    throw new Error(`Tool definition ${name} was not found`);
  }

  return definition.description;
}

function toolDefinition(name: string): (typeof customToolDefinitions)[number] {
  const definition = customToolDefinitions.find((tool) => tool.name === name);
  if (!definition) {
    throw new Error(`Tool definition ${name} was not found`);
  }

  return definition;
}

describe("tool definitions", () => {
  it("keeps daily reminder contents separate from scheduled notification setup", () => {
    expect(toolDescription("upsert_task")).toContain("inside an existing daily reminder");
    expect(toolDescription("search_tasks")).toContain("Search tracked tasks");
    expect(toolDescription("search_tasks")).toContain("all statuses");
    expect(toolDescription("patch_task")).toContain("partial update");
    expect(toolDescription("patch_task")).toContain("search_tasks");
    expect(toolDescription("create_scheduled_reminder")).toContain("explicitly asks for an individual reminder");
    expect(toolDescription("create_scheduled_reminder")).toContain("one-off events");
    expect(toolDescription("update_scheduled_reminder")).toContain("explicit changes to a separate notification schedule");
    expect(toolDescription("list_scheduled_reminders")).toContain("included in the daily reminder instead");
    expect(toolDescription("delete_scheduled_reminder")).toContain("accidental individual reminder");
    expect(toolDefinition("search_tasks").input_schema.required).toEqual(["query"]);
    expect(toolDefinition("patch_task").input_schema.required).toEqual(["task_id"]);
  });

  it("keeps generated skill creation draft-first", () => {
    const proposeSkill = toolDefinition("propose_skill");

    expect(toolDescription("propose_skill")).toContain("proposed generated skill");
    expect(toolDescription("propose_skill")).toContain("does not enable");
    expect(toolDescription("propose_skill")).toContain("explicit confirmation");
    expect(toolDescription("propose_skill")).toContain("Do not call propose_skill based only on inferred intent");
    expect(proposeSkill.input_schema.required).toEqual(
      expect.arrayContaining(["skill_markdown", "evaluation_notes", "test_cases"]),
    );
    expect(toolDescription("approve_skill")).toContain("Approve");
    expect(toolDescription("approve_skill")).not.toContain("Enable");
    expect(toolDescription("enable_skill")).toContain("Enable an approved");
    expect(toolDescription("reject_skill")).toContain("Reject a proposed");
    expect(toolDescription("archive_skill")).toContain("Archive a generated");
    expect(toolDescription("disable_skill")).toContain("generated skill");

    const listSkills = customToolDefinitions.find((tool) => tool.name === "list_skills")!;
    expect(JSON.stringify(listSkills.input_schema)).toContain("proposed");
    expect(JSON.stringify(listSkills.input_schema)).toContain("archived");
  });

  it("exposes browser tools without provider-specific implementation details", () => {
    for (const name of [
      "browser_start",
      "browser_open_url",
      "browser_snapshot",
      "browser_extract",
      "browser_close",
    ]) {
      const description = toolDescription(name);
      expect(description).not.toMatch(/AWS|AgentCore|Bedrock/i);
    }
    expect(toolDescription("browser_open_url")).toContain("public http or https URL");
    expect(toolDescription("browser_snapshot")).toContain("Screenshots are not returned as raw image data");
  });

  it("requires explicit approval before promoting channel memory", () => {
    expect(toolDescription("promote_memory_to_workspace")).toContain("explicitly approves");
    expect(toolDescription("promote_memory_to_workspace")).toContain("current-channel memory");
    expect(toolDescription("promote_memory_to_workspace")).toContain("does not delete");
  });

  it("exposes archived attachment image reading by source ID", () => {
    const readAttachmentImage = toolDefinition("read_attachment_image");

    expect(readAttachmentImage.description).toContain("Only use source IDs");
    expect(readAttachmentImage.input_schema.required).toEqual(expect.arrayContaining(["source_id"]));
    expect(readAttachmentImage.input_schema.properties.source_id).toMatchObject({
      type: "string",
    });
  });
});
