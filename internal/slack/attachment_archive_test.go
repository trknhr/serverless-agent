package slack

import (
	"regexp"
	"testing"
)

func TestAttachmentArchiveFileNameSanitization(t *testing.T) {
	service := testAttachmentArchiveService()

	tests := map[string]string{
		"Quarterly Report.pdf": "Quarterly_Report.pdf",
		"  weird / name  ":     "weird_name.txt",
		"***":                  "src_123.txt",
		"":                     "src_123.json",
	}

	for label, want := range tests {
		mimeType := "text/plain"
		if label == "" {
			mimeType = "application/json"
		}
		if got := service.sanitizeFileName(label, "src_123", mimeType); got != want {
			t.Fatalf("sanitizeFileName(%q) = %q, want %q", label, got, want)
		}
	}
}

func TestAttachmentArchiveBuildS3Key(t *testing.T) {
	service := testAttachmentArchiveService()

	key := service.buildS3Key("T123", "src_123", "Report", "application/pdf", "2026-05-09T12:34:56Z")

	want := "raw/private/slack/T123/2026/05/src_123/Report.pdf"
	if key != want {
		t.Fatalf("buildS3Key() = %q, want %q", key, want)
	}
}

func TestMapAttachmentStatus(t *testing.T) {
	tests := map[string]string{
		"ready":                 "archived",
		"external_link":         "external_link",
		"skipped_missing_url":   "skipped_missing_url",
		"skipped_oversize":      "skipped_oversize",
		"skipped_unsupported":   "skipped_unsupported",
		"download_failed":       "download_failed",
		"unexpected_new_status": "archived",
	}

	for status, want := range tests {
		if got := mapAttachmentStatus(status); got != want {
			t.Fatalf("mapAttachmentStatus(%q) = %q, want %q", status, got, want)
		}
	}
}

func TestZeroToNilString(t *testing.T) {
	if zeroToNilString("") != nil {
		t.Fatal("zeroToNilString(\"\") returned non-nil")
	}
	if got := zeroToNilString("text/plain"); got == nil || *got != "text/plain" {
		t.Fatalf("zeroToNilString returned %#v", got)
	}
}

func testAttachmentArchiveService() *AttachmentArchiveService {
	return &AttachmentArchiveService{
		sanitizer:   regexp.MustCompile(`[^a-zA-Z0-9._-]+`),
		extensionRE: regexp.MustCompile(`\.[a-zA-Z0-9]+$`),
	}
}
