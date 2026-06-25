import { describe, expect, it } from "vitest";
import { buildSystemPrompt, parseSystemPromptMode } from "../src/agentcore/instructions";

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
    expect(prompt).toContain("returned task_id, recurring_task_id, or memory_id");
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

  it("starts Google Calendar authorization through the dedicated tool", () => {
    const prompt = buildSystemPrompt("");

    expect(prompt).toContain("start_google_calendar_authorization");
    expect(prompt).toContain("connect, authorize, link, or sign in to Google Calendar");
    expect(prompt).toContain("Do not ask what kind of calendar integration");
  });

  it("does not invite broad Google Calendar use for ordinary reminders", () => {
    const prompt = buildSystemPrompt("");

    expect(prompt).not.toContain("calendar operations when they are relevant");
    expect(prompt).toContain("Use Google Calendar tools only when the user explicitly asks");
  });

  it("appends deployment-specific system prompt instructions by default", () => {
    const prompt = buildSystemPrompt("Skill summaries.", {
      customSystemPrompt: "Deployment-specific instructions.",
    });

    expect(prompt).toContain("Use tools for durable memory");
    expect(prompt).toContain("Deployment-specific instructions.");
    expect(prompt).toContain("Skill summaries.");
  });

  it("can replace the default system prompt with deployment-specific instructions", () => {
    const prompt = buildSystemPrompt("Skill summaries.", {
      customSystemPrompt: "Deployment-specific instructions.",
      systemPromptMode: "replace",
    });

    expect(prompt).not.toContain("Use tools for durable memory");
    expect(prompt).toBe("Deployment-specific instructions.\n\nSkill summaries.");
  });

  it("parses custom system prompt mode from runtime environment values", () => {
    expect(parseSystemPromptMode(undefined)).toBe("append");
    expect(parseSystemPromptMode("append")).toBe("append");
    expect(parseSystemPromptMode("replace")).toBe("replace");
    expect(() => parseSystemPromptMode("invalid")).toThrow("Invalid SYSTEM_PROMPT_MODE");
  });
});
