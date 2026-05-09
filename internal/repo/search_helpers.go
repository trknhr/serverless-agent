package repo

import (
	"encoding/json"
	"strings"
)

func normalizeSearchValue(value string) string {
	return strings.ToLower(strings.TrimSpace(value))
}

func buildSearchText(text string, attributes map[string]any, tags []string) string {
	parts := []string{text}
	if len(attributes) > 0 {
		if payload, err := json.Marshal(attributes); err == nil {
			parts = append(parts, string(payload))
		}
	}
	if len(tags) > 0 {
		parts = append(parts, strings.Join(tags, " "))
	}
	return normalizeSearchValue(strings.Join(parts, " "))
}

func matchesSearch(searchText string, terms []string) bool {
	if len(terms) == 0 {
		return true
	}
	for _, term := range terms {
		if !strings.Contains(searchText, term) {
			return false
		}
	}
	return true
}
