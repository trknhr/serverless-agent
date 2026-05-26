import { describe, expect, it } from "vitest";
import { customToolDefinitions } from "../src/tools/definitions";

function toolDescription(name: string): string {
  const definition = customToolDefinitions.find((tool) => tool.name === name);
  if (!definition) {
    throw new Error(`Tool definition ${name} was not found`);
  }

  return definition.description;
}

describe("tool definitions", () => {
  it("keeps daily reminder contents separate from scheduled notification setup", () => {
    expect(toolDescription("upsert_task")).toContain("inside an existing daily reminder");
    expect(toolDescription("create_scheduled_reminder")).toContain("explicitly asks for an individual reminder");
    expect(toolDescription("create_scheduled_reminder")).toContain("one-off events");
    expect(toolDescription("update_scheduled_reminder")).toContain("explicit changes to a separate notification schedule");
    expect(toolDescription("list_scheduled_reminders")).toContain("included in the daily reminder instead");
    expect(toolDescription("delete_scheduled_reminder")).toContain("accidental individual reminder");
  });

  it("keeps generated skill creation draft-first", () => {
    expect(toolDescription("propose_skill")).toContain("draft generated skill");
    expect(toolDescription("propose_skill")).toContain("does not enable");
    expect(toolDescription("approve_skill")).toContain("explicitly approves");
    expect(toolDescription("disable_skill")).toContain("generated skill");
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
});
