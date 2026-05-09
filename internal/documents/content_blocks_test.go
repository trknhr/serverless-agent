package documents

import (
	"encoding/base64"
	"testing"
)

func TestBuildClaudeContentBlocksForPDF(t *testing.T) {
	blocks := BuildClaudeContentBlocksForDocument("brief.pdf", "application/pdf", []byte("pdf-data"))

	if len(blocks) != 1 {
		t.Fatalf("expected 1 block, got %d", len(blocks))
	}
	if blocks[0]["type"] != "document" || blocks[0]["title"] != "brief.pdf" {
		t.Fatalf("unexpected document block: %#v", blocks[0])
	}
	source := blocks[0]["source"].(map[string]any)
	if source["type"] != "base64" || source["media_type"] != "application/pdf" {
		t.Fatalf("unexpected source metadata: %#v", source)
	}
	if source["data"] != base64.StdEncoding.EncodeToString([]byte("pdf-data")) {
		t.Fatalf("unexpected encoded data: %q", source["data"])
	}
}

func TestBuildClaudeContentBlocksForImage(t *testing.T) {
	blocks := BuildClaudeContentBlocksForDocument("photo.png", "image/png", []byte("image-data"))

	if len(blocks) != 2 {
		t.Fatalf("expected 2 blocks, got %d", len(blocks))
	}
	if blocks[0]["type"] != "text" || blocks[0]["text"] != "Attached image: photo.png" {
		t.Fatalf("unexpected image preface block: %#v", blocks[0])
	}
	if blocks[1]["type"] != "image" {
		t.Fatalf("unexpected image block: %#v", blocks[1])
	}
	source := blocks[1]["source"].(map[string]any)
	if source["media_type"] != "image/png" || source["data"] != base64.StdEncoding.EncodeToString([]byte("image-data")) {
		t.Fatalf("unexpected image source: %#v", source)
	}
}

func TestBuildClaudeContentBlocksForTextLikeMIME(t *testing.T) {
	for _, mimeType := range []string{"text/plain", "text/markdown", "application/json", "application/xml", "application/javascript"} {
		t.Run(mimeType, func(t *testing.T) {
			blocks := BuildClaudeContentBlocksForDocument("notes", mimeType, []byte("hello"))

			if len(blocks) != 1 {
				t.Fatalf("expected 1 block, got %d", len(blocks))
			}
			source := blocks[0]["source"].(map[string]any)
			if source["type"] != "text" || source["media_type"] != "text/plain" || source["data"] != "hello" {
				t.Fatalf("unexpected text source: %#v", source)
			}
		})
	}
}

func TestBuildClaudeContentBlocksForUnsupportedMIME(t *testing.T) {
	blocks := BuildClaudeContentBlocksForDocument("archive.zip", "", []byte("zip"))

	if len(blocks) != 1 {
		t.Fatalf("expected 1 block, got %d", len(blocks))
	}
	if blocks[0]["text"] != "Attachment note: archive.zip (unknown mime type) is not supported for inline analysis." {
		t.Fatalf("unexpected unsupported note: %#v", blocks[0])
	}
}
