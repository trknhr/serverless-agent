import { describe, expect, it, vi } from "vitest";
import { CalendarDraft } from "../src/calendar/calendarDraft";
import { CustomToolExecutor } from "../src/tools/executeCustomTool";
import { Logger } from "../src/shared/logger";

const draftTitle = "Sample draft";
const eventSummary = "Sample event";

class InMemoryCalendarDraftRepository {
  private readonly drafts = new Map<string, CalendarDraft>();

  async save(draft: CalendarDraft): Promise<CalendarDraft> {
    this.drafts.set(this.key(draft.workspaceId, draft.userId, draft.draftId), cloneDraft(draft));
    return draft;
  }

  async get(workspaceId: string, userId: string | undefined, draftId: string): Promise<CalendarDraft | null> {
    const draft = this.drafts.get(this.key(workspaceId, userId, draftId));
    return draft ? cloneDraft(draft) : null;
  }

  private key(workspaceId: string, userId: string | undefined, draftId: string): string {
    return `${workspaceId}:${userId ?? ""}:${draftId}`;
  }
}

describe("calendar draft tools", () => {
  it("returns a human-readable result after applying a calendar draft", async () => {
    const draft = createDraft();
    const calendarDrafts = new InMemoryCalendarDraftRepository();
    await calendarDrafts.save(draft);

    const googleCalendar = {
      findEventByPrivateProperties: vi.fn().mockResolvedValue(null),
      createEvent: vi.fn().mockResolvedValue({
        id: "event_1",
        htmlLink: "https://calendar.google.com/event?eid=event_1",
        summary: eventSummary,
      }),
      patchEvent: vi.fn(),
    };
    const executor = createExecutor(calendarDrafts, googleCalendar);

    const result = await executor.execute({
      id: "tool-1",
      type: "agent.tool_use",
      name: "apply_calendar_draft",
      input: { draft_id: draft.draftId },
    });
    const text = firstText(result);

    expect(result.isError).toBeUndefined();
    expect(text).toContain(`カレンダー下書き「${draftTitle}」を承認し`);
    expect(text).toContain("Google Calendarに1件の予定を反映しました。");
    expect(text).toContain(`- 作成: ${eventSummary}`);
    expect(text).not.toMatch(/^\s*\{/);
    expect(text).not.toContain("event_id");
    expect(text).not.toContain("html_link");
  });

  it("returns a human-readable result after discarding a calendar draft", async () => {
    const draft = createDraft();
    const calendarDrafts = new InMemoryCalendarDraftRepository();
    await calendarDrafts.save(draft);
    const executor = createExecutor(calendarDrafts, {});

    const result = await executor.execute({
      id: "tool-2",
      type: "agent.tool_use",
      name: "discard_calendar_draft",
      input: { draft_id: draft.draftId },
    });
    const text = firstText(result);

    expect(result.isError).toBeUndefined();
    expect(text).toContain(`カレンダー下書き「${draftTitle}」を却下しました。`);
    expect(text).toContain(`- 却下: ${eventSummary}`);
    expect(text).not.toMatch(/^\s*\{/);
    expect(text).not.toContain("rejected_candidate_ids");
  });
});

function createExecutor(
  calendarDrafts: InMemoryCalendarDraftRepository,
  googleCalendar: Record<string, unknown>,
): CustomToolExecutor {
  return new CustomToolExecutor(
    {
      memoryItems: {},
      tasks: {},
      taskEvents: {},
      calendarDrafts,
    } as never,
    {
      workspaceId: "T1",
      userId: "U1",
      logger: new Logger({ test: "calendar-draft-tools" }),
    },
    {
      googleCalendar: googleCalendar as never,
      defaultCalendarTimeZone: "Asia/Tokyo",
    },
  );
}

function createDraft(): CalendarDraft {
  return {
    draftId: "draft_1",
    workspaceId: "T1",
    userId: "U1",
    title: draftTitle,
    calendarId: "primary",
    status: "pending",
    candidates: [
      {
        candidateId: "candidate_1",
        summary: eventSummary,
        allDay: true,
        startDate: "2026-06-13",
        endDate: "2026-06-14",
        status: "pending",
      },
    ],
    createdAt: "2026-06-08T00:00:00.000Z",
    updatedAt: "2026-06-08T00:00:00.000Z",
  };
}

function firstText(result: Awaited<ReturnType<CustomToolExecutor["execute"]>>): string {
  const text = result.content?.[0]?.type === "text" ? result.content[0].text : "";
  expect(text).not.toBe("");
  return text;
}

function cloneDraft(draft: CalendarDraft): CalendarDraft {
  return {
    ...draft,
    candidates: draft.candidates.map((candidate) => ({ ...candidate })),
  };
}
