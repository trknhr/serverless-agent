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

    expect(prompt).toContain("search_context");
    expect(prompt).toContain("short-term references");
    expect(prompt).toContain("past-context questions");
    expect(prompt).toContain("task keyword searches");
    expect(prompt).toContain("named task exists");
    expect(prompt).toContain("Do not use list_tasks as a substitute for keyword search");
    expect(prompt).toContain("exact term or question");
    expect(prompt).toContain("returned task_id or memory_id");
    expect(prompt).toContain("include_web=true");
  });

  it("tells the model to read image manifests lazily", () => {
    const prompt = buildSystemPrompt("");

    expect(prompt).toContain("available image attachment manifest");
    expect(prompt).toContain("do not infer image contents from the manifest alone");
    expect(prompt).toContain("Call read_attachment_image only when");
    expect(prompt).toContain("question field");
    expect(prompt).toContain("current request is unrelated to the image");
    expect(prompt).toContain("source IDs explicitly shown in the current attachment manifest");
  });
});
