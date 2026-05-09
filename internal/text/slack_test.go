package text

import (
	"strings"
	"testing"
)

func TestNormalizeTextForSlackTransformsMarkdownOutsideCode(t *testing.T) {
	input := "  **bold** __under__ ~~gone~~ [docs](https://example.com/docs)\n`**code** [x](https://example.com)`\n```[block](https://example.com)```  "

	got := NormalizeTextForSlack(input)
	want := "*bold* _under_ ~gone~ <https://example.com/docs|docs>\n`**code** [x](https://example.com)`\n```[block](https://example.com)```"

	if got != want {
		t.Fatalf("NormalizeTextForSlack() = %q, want %q", got, want)
	}
}

func TestSplitTextForSlackPrefersParagraphBreaks(t *testing.T) {
	input := "alpha bravo charlie\n\n" + strings.Repeat("delta ", 8) + "\n\necho"

	chunks := SplitTextForSlack(input, 25)

	if len(chunks) != 4 {
		t.Fatalf("expected 4 chunks, got %d: %#v", len(chunks), chunks)
	}
	if chunks[0] != "alpha bravo charlie" {
		t.Fatalf("expected first chunk to split at paragraph break, got %q", chunks[0])
	}
	for _, chunk := range chunks {
		if strings.TrimSpace(chunk) != chunk {
			t.Fatalf("chunk was not trimmed: %q", chunk)
		}
		if len(chunk) > 25 {
			t.Fatalf("chunk %q exceeds max length", chunk)
		}
	}
}

func TestSplitTextForSlackUsesDefaultMaxLength(t *testing.T) {
	input := strings.Repeat("x", 3001)

	chunks := SplitTextForSlack(input, 0)

	if len(chunks) != 2 {
		t.Fatalf("expected default 3000 character split, got %d chunks", len(chunks))
	}
	if len(chunks[0]) != 3000 || len(chunks[1]) != 1 {
		t.Fatalf("unexpected chunk lengths: %d, %d", len(chunks[0]), len(chunks[1]))
	}
}
