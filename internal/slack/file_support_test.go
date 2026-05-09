package slack

import "testing"

func TestInferMimeTypeFromName(t *testing.T) {
	tests := map[string]string{
		" Report.PDF ": "application/pdf",
		"photo.jpeg":   "image/jpeg",
		"chart.JPG":    "image/jpeg",
		"image.png":    "image/png",
		"anim.gif":     "image/gif",
		"notes.md":     "text/plain",
		"data.json":    "application/json",
		"archive.zip":  "",
	}

	for name, want := range tests {
		if got := InferMimeTypeFromName(name); got != want {
			t.Fatalf("InferMimeTypeFromName(%q) = %q, want %q", name, got, want)
		}
	}
}

func TestSupportedMimeTypesAndDefaultExtensions(t *testing.T) {
	if !IsSupportedSlackArchiveMimeType("application/pdf") || !IsSupportedSlackArchiveMimeType("image/webp") || !IsSupportedSlackArchiveMimeType("text/csv") {
		t.Fatal("expected pdf, image, and text mime types to be supported for Slack archive")
	}
	if IsSupportedSlackArchiveMimeType("application/zip") {
		t.Fatal("expected application/zip to be unsupported")
	}
	if !IsSupportedLocalImportMimeType("image/jpeg") || IsSupportedLocalImportMimeType("image/webp") {
		t.Fatal("unexpected local import support result")
	}

	tests := map[string]string{
		"application/pdf":  ".pdf",
		"image/jpeg":       ".jpg",
		"text/markdown":    ".md",
		"text/plain":       ".txt",
		"application/json": ".json",
		"application/zip":  "",
	}
	for mimeType, want := range tests {
		if got := DefaultExtensionForMimeType(mimeType); got != want {
			t.Fatalf("DefaultExtensionForMimeType(%q) = %q, want %q", mimeType, got, want)
		}
	}
}
