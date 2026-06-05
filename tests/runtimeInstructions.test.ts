import { describe, expect, it } from "vitest";
import { buildSystemPrompt } from "../src/agentcore/instructions";

describe("Agent runtime instructions", () => {
  it("asks before creating automatic generated skill drafts", () => {
    const prompt = buildSystemPrompt("");

    expect(prompt).toContain("repeated or automatable workflow");
    expect(prompt).toContain("ask the user before calling propose_skill");
    expect(prompt).toContain("Do not call propose_skill based only on inferred intent");
    expect(prompt).toContain("evaluation notes and at least one concrete test case");
  });

  it("looks up tasks when answering task-derived context questions", () => {
    const prompt = buildSystemPrompt("");

    expect(prompt).toContain("search_tasks");
    expect(prompt).toContain("past reminders");
    expect(prompt).toContain("deadlines");
    expect(prompt).toContain("items to bring");
  });
});
