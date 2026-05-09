package idgen

import (
	"strings"
	"testing"
)

func TestNewReturnsPrefixedHexID(t *testing.T) {
	id := New("src_")

	if !strings.HasPrefix(id, "src_") {
		t.Fatalf("id %q does not have prefix", id)
	}
	if len(id) != len("src_")+32 {
		t.Fatalf("id length = %d, want %d", len(id), len("src_")+32)
	}
	for _, char := range strings.TrimPrefix(id, "src_") {
		if !strings.ContainsRune("0123456789abcdef", char) {
			t.Fatalf("id contains non-hex character %q: %q", char, id)
		}
	}
}

func TestNewReturnsUniqueIDs(t *testing.T) {
	first := New("id_")
	second := New("id_")

	if first == second {
		t.Fatalf("expected unique IDs, got %q twice", first)
	}
}
