package slack

import (
	"testing"

	"github.com/trknhr/slack-ai-assistant/internal/anthropic"
	"github.com/trknhr/slack-ai-assistant/internal/contracts"
)

func TestBuildContentBlocksHonorsInlineLimit(t *testing.T) {
	client := NewFilesClient(nil, 1000)
	attachments := []PreparedAttachment{
		{ContentBlocks: []anthropic.InputBlock{{"type": "text", "text": "one"}}},
		{ContentBlocks: []anthropic.InputBlock{{"type": "text", "text": "two"}}},
		{ContentBlocks: []anthropic.InputBlock{{"type": "text", "text": "three"}}},
	}

	blocks := client.BuildContentBlocks(attachments, 2)

	if len(blocks) != 3 {
		t.Fatalf("expected 3 blocks including omission note, got %d", len(blocks))
	}
	if blocks[0]["text"] != "one" || blocks[1]["text"] != "two" {
		t.Fatalf("unexpected inline blocks: %#v", blocks)
	}
	if blocks[2]["text"] != "Attachment note: 1 additional file(s) were archived but omitted from inline analysis to keep the request bounded." {
		t.Fatalf("unexpected omission note: %#v", blocks[2])
	}
}

func TestExtractSlackFiles(t *testing.T) {
	size := float64(123)
	input := []any{
		map[string]any{
			"id":                   "F123",
			"name":                 "report.pdf",
			"title":                "Report",
			"mimetype":             "application/pdf",
			"file_access":          "visible",
			"url_private":          "https://files.slack.com/file",
			"url_private_download": "https://files.slack.com/download",
			"permalink":            "https://slack.com/files/F123",
			"is_external":          true,
			"external_url":         "https://example.com/file",
			"size":                 size,
		},
		map[string]any{"name": "missing-id"},
		"not-a-file",
	}

	files := extractSlackFiles(input)

	if len(files) != 1 {
		t.Fatalf("expected 1 file, got %d", len(files))
	}
	file := files[0]
	if file.ID != "F123" || file.Name != "report.pdf" || file.Title != "Report" || file.Mimetype != "application/pdf" {
		t.Fatalf("unexpected file metadata: %#v", file)
	}
	if file.IsExternal == nil || !*file.IsExternal {
		t.Fatalf("expected external file pointer to be true: %#v", file.IsExternal)
	}
	if file.Size == nil || *file.Size != 123 {
		t.Fatalf("expected size pointer 123, got %#v", file.Size)
	}
}

func TestChooseHelpers(t *testing.T) {
	first := false
	second := true
	if got := chooseBoolPtr(nil, &first, &second); got == nil || *got {
		t.Fatalf("chooseBoolPtr returned %#v, want false pointer", got)
	}

	a := int64(5)
	b := int64(10)
	if got := chooseInt64Ptr(nil, &a, &b); got == nil || *got != 5 {
		t.Fatalf("chooseInt64Ptr returned %#v, want 5 pointer", got)
	}

	if got := chooseLabel(contracts.SlackFileReference{ID: "F1", Title: "Title", Name: "name.txt"}); got != "name.txt" {
		t.Fatalf("chooseLabel = %q, want name.txt", got)
	}
}
