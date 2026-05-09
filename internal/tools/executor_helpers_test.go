package tools

import (
	"strings"
	"testing"

	"github.com/trknhr/slack-ai-assistant/internal/calendar"
	"github.com/trknhr/slack-ai-assistant/internal/tasks"
)

func TestNormalizeEntityKeyAndTags(t *testing.T) {
	if got := normalizeEntityKey(" Person Hanako "); got != "person-hanako" {
		t.Fatalf("normalizeEntityKey() = %q", got)
	}

	tags := normalizeTags([]string{" Project ", "project", "Family Schedule", ""})
	if strings.Join(tags, ",") != "project,family_schedule" {
		t.Fatalf("normalizeTags() = %#v", tags)
	}
	if normalizeTags([]string{" ", ""}) != nil {
		t.Fatal("expected empty normalized tags to be nil")
	}
}

func TestInferMemoryScopes(t *testing.T) {
	if got := inferSearchScope(ToolExecutionContext{ChannelID: "C123"}); got != "all" {
		t.Fatalf("inferSearchScope with channel = %q", got)
	}
	if got := inferSearchScope(ToolExecutionContext{}); got != "workspace" {
		t.Fatalf("inferSearchScope without channel/user = %q", got)
	}
	if got := inferSaveScope(ToolExecutionContext{ChannelID: "C123", UserID: "U123"}); got != "channel" {
		t.Fatalf("inferSaveScope with channel = %q", got)
	}
	if got := inferSaveScope(ToolExecutionContext{UserID: "U123"}); got != "user_preference" {
		t.Fatalf("inferSaveScope with user = %q", got)
	}
}

func TestFindCalendarByName(t *testing.T) {
	calendars := []calendar.GoogleCalendarListEntry{
		{ID: "primary", Summary: "Personal", AccessRole: "owner"},
		{ID: "team@example.com", Summary: "Team Calendar", SummaryOverride: "Work", AccessRole: "writer"},
	}

	match, err := findCalendarByName(calendars, "work")
	if err != nil {
		t.Fatalf("findCalendarByName returned error: %v", err)
	}
	if match == nil || match.ID != "team@example.com" {
		t.Fatalf("unexpected match: %#v", match)
	}

	match, err = findCalendarByName(calendars, "team")
	if err != nil {
		t.Fatalf("findCalendarByName partial returned error: %v", err)
	}
	if match == nil || match.ID != "team@example.com" {
		t.Fatalf("unexpected partial match: %#v", match)
	}

	match, err = findCalendarByName(calendars, "missing")
	if err != nil || match != nil {
		t.Fatalf("missing calendar = %#v, %v; want nil, nil", match, err)
	}
}

func TestFindCalendarByNameRejectsAmbiguousMatches(t *testing.T) {
	calendars := []calendar.GoogleCalendarListEntry{
		{ID: "a@example.com", Summary: "Work"},
		{ID: "b@example.com", SummaryOverride: "Work"},
	}

	if _, err := findCalendarByName(calendars, "work"); err == nil {
		t.Fatal("expected ambiguous calendar name error")
	}
}

func TestNormalizeCalendarDraftCandidateAllDay(t *testing.T) {
	confidence := float64(0.8)
	candidate, err := normalizeCalendarDraftCandidate(map[string]any{
		"candidate_id": "calcand_fixed",
		"summary":      " School event ",
		"start_date":   "2026-06-01",
		"confidence":   confidence,
	}, "Asia/Tokyo", "src_123", "slack://thread")
	if err != nil {
		t.Fatalf("normalizeCalendarDraftCandidate returned error: %v", err)
	}

	if candidate.CandidateID != "calcand_fixed" || candidate.Summary != "School event" || !candidate.AllDay {
		t.Fatalf("unexpected candidate: %#v", candidate)
	}
	if candidate.EndDate != "2026-06-01" || candidate.TimeZone != "Asia/Tokyo" || candidate.Status != "pending" {
		t.Fatalf("unexpected candidate defaults: %#v", candidate)
	}
	if candidate.Confidence == nil || *candidate.Confidence != confidence {
		t.Fatalf("unexpected confidence: %#v", candidate.Confidence)
	}
	if !strings.HasPrefix(candidate.DedupeKey, "dedupe_") {
		t.Fatalf("unexpected dedupe key: %q", candidate.DedupeKey)
	}
}

func TestNormalizeCalendarDraftCandidateTimedValidation(t *testing.T) {
	candidate, err := normalizeCalendarDraftCandidate(map[string]any{
		"candidate_id": "calcand_fixed",
		"summary":      "Meeting",
		"start_at":     "2026-06-01T10:00:00+09:00",
		"end_at":       "2026-06-01T11:00:00+09:00",
	}, "Asia/Tokyo", "", "")
	if err != nil {
		t.Fatalf("normalizeCalendarDraftCandidate returned error: %v", err)
	}
	if candidate.AllDay || candidate.StartAt == "" || candidate.EndAt == "" {
		t.Fatalf("unexpected timed candidate: %#v", candidate)
	}

	_, err = normalizeCalendarDraftCandidate(map[string]any{
		"summary":    "Invalid",
		"start_date": "2026-06-01",
		"start_at":   "2026-06-01T10:00:00+09:00",
		"end_at":     "2026-06-01T11:00:00+09:00",
	}, "Asia/Tokyo", "", "")
	if err == nil {
		t.Fatal("expected all-day/timed conflict error")
	}

	_, err = normalizeCalendarDraftCandidate(map[string]any{
		"summary":  "Invalid",
		"start_at": "2026-06-01T11:00:00+09:00",
		"end_at":   "2026-06-01T10:00:00+09:00",
	}, "Asia/Tokyo", "", "")
	if err == nil {
		t.Fatal("expected end_at ordering error")
	}
}

func TestBuildGoogleCalendarEventBody(t *testing.T) {
	allDay := buildGoogleCalendarEventBody(calendar.DraftCandidate{
		Summary:   "All day",
		AllDay:    true,
		StartDate: "2026-06-01",
		EndDate:   "2026-06-02",
	}, map[string]string{"k": "v"}, "Asia/Tokyo")

	if allDay["start"].(map[string]any)["date"] != "2026-06-01" || allDay["end"].(map[string]any)["date"] != "2026-06-03" {
		t.Fatalf("unexpected all-day body: %#v", allDay)
	}

	timed := buildGoogleCalendarEventBody(calendar.DraftCandidate{
		Summary: "Timed",
		StartAt: "2026-06-01T10:00:00+09:00",
		EndAt:   "2026-06-01T11:00:00+09:00",
	}, nil, "Asia/Tokyo")
	if timed["start"].(map[string]any)["timeZone"] != "Asia/Tokyo" || timed["end"].(map[string]any)["dateTime"] == "" {
		t.Fatalf("unexpected timed body: %#v", timed)
	}
}

func TestResolveCalendarDraftStatus(t *testing.T) {
	tests := []struct {
		name       string
		candidates []calendar.DraftCandidate
		want       string
	}{
		{name: "empty", candidates: nil, want: "applied"},
		{name: "all rejected", candidates: []calendar.DraftCandidate{{Status: "rejected"}, {Status: "rejected"}}, want: "rejected"},
		{name: "pending only", candidates: []calendar.DraftCandidate{{Status: "pending"}}, want: "pending"},
		{name: "applied with pending", candidates: []calendar.DraftCandidate{{Status: "applied"}, {Status: "pending"}}, want: "approved"},
		{name: "all applied", candidates: []calendar.DraftCandidate{{Status: "applied"}}, want: "applied"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := resolveCalendarDraftStatus(tt.candidates); got != tt.want {
				t.Fatalf("resolveCalendarDraftStatus() = %q, want %q", got, tt.want)
			}
		})
	}
}

func TestOptionalInputHelpers(t *testing.T) {
	input := map[string]any{
		"string":   " value ",
		"strings":  []any{" a ", "b"},
		"map":      map[string]any{"k": "v"},
		"float":    float64(0.5),
		"int_low":  float64(-1),
		"int_high": float64(99),
		"bool":     true,
		"statuses": []any{"open", "done"},
	}

	if got, err := requiredString(input, "string"); err != nil || got != "value" {
		t.Fatalf("requiredString = %q, %v", got, err)
	}
	if got, err := optionalStringSlice(input, "strings"); err != nil || strings.Join(got, ",") != "a,b" {
		t.Fatalf("optionalStringSlice = %#v, %v", got, err)
	}
	if got, err := optionalMap(input, "map"); err != nil || got["k"] != "v" {
		t.Fatalf("optionalMap = %#v, %v", got, err)
	}
	if got, err := optionalFloatPtr(input, "float", 0, 1); err != nil || got == nil || *got != 0.5 {
		t.Fatalf("optionalFloatPtr = %#v, %v", got, err)
	}
	if got := optionalInt(input, "missing", 5, 1, 10); got != 5 {
		t.Fatalf("optionalInt missing = %d", got)
	}
	if got := optionalInt(input, "int_low", 5, 1, 10); got != 1 {
		t.Fatalf("optionalInt low = %d", got)
	}
	if got := optionalInt(input, "int_high", 5, 1, 10); got != 10 {
		t.Fatalf("optionalInt high = %d", got)
	}
	if got, ok := optionalBool(input, "bool"); !ok || !got {
		t.Fatalf("optionalBool = %v, %v", got, ok)
	}
	statuses, err := optionalStatuses(input, "statuses")
	if err != nil || len(statuses) != 2 || statuses[0] != tasks.StatusOpen || statuses[1] != tasks.StatusDone {
		t.Fatalf("optionalStatuses = %#v, %v", statuses, err)
	}
}

func TestParseStatusAndAccessRole(t *testing.T) {
	if status, err := parseStatus("in_progress"); err != nil || status != tasks.StatusInProgress {
		t.Fatalf("parseStatus = %q, %v", status, err)
	}
	if _, err := parseStatus("blocked"); err == nil {
		t.Fatal("expected invalid status error")
	}
	if !isAllowedAccessRole("freeBusyReader") || !isAllowedAccessRole("owner") || isAllowedAccessRole("admin") {
		t.Fatal("unexpected access role validation result")
	}
}
