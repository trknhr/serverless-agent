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
});
