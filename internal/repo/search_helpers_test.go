package repo

import (
	"strings"
	"testing"
)

func TestBuildSearchTextNormalizesTextAttributesAndTags(t *testing.T) {
	searchText := buildSearchText("  Hello World  ", map[string]any{
		"project": "Migration",
		"count":   float64(2),
	}, []string{"Go", "Lambda"})

	for _, want := range []string{"hello world", `"project":"Migration"`, "go lambda"} {
		if !strings.Contains(searchText, strings.ToLower(want)) {
			t.Fatalf("expected search text %q to contain %q", searchText, strings.ToLower(want))
		}
	}
	if searchText != strings.TrimSpace(searchText) {
		t.Fatalf("search text was not trimmed: %q", searchText)
	}
}

func TestMatchesSearchRequiresAllTerms(t *testing.T) {
	searchText := normalizeSearchValue("Project migration deadline")

	if !matchesSearch(searchText, []string{"project", "deadline"}) {
		t.Fatal("expected all terms to match")
	}
	if matchesSearch(searchText, []string{"project", "missing"}) {
		t.Fatal("expected missing term to fail")
	}
	if !matchesSearch(searchText, nil) {
		t.Fatal("expected empty term list to match")
	}
}
