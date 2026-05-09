package text

import (
	"regexp"
	"strings"
)

func SplitTextForSlack(text string, maxLength int) []string {
	if maxLength <= 0 {
		maxLength = 3000
	}
	normalized := strings.TrimSpace(text)
	if len(normalized) <= maxLength {
		return []string{normalized}
	}

	chunks := make([]string, 0)
	cursor := 0
	for cursor < len(normalized) {
		end := cursor + maxLength
		if end > len(normalized) {
			end = len(normalized)
		}
		next := normalized[cursor:end]
		breakIndex := strings.LastIndex(next, "\n\n")
		sliceLength := len(next)
		if breakIndex > maxLength/2 {
			sliceLength = breakIndex
		}
		chunk := strings.TrimSpace(normalized[cursor : cursor+sliceLength])
		if chunk != "" {
			chunks = append(chunks, chunk)
		}
		cursor += sliceLength
	}
	return chunks
}

var (
	linkPattern          = regexp.MustCompile(`\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)`)
	boldPattern          = regexp.MustCompile(`(?s)\*\*(.+?)\*\*`)
	underlinePattern     = regexp.MustCompile(`(?s)__(.+?)__`)
	strikethroughPattern = regexp.MustCompile(`(?s)~~(.+?)~~`)
)

func NormalizeTextForSlack(text string) string {
	return strings.TrimSpace(transformOutsideCode(text, func(segment string) string {
		segment = linkPattern.ReplaceAllString(segment, "<$2|$1>")
		segment = boldPattern.ReplaceAllString(segment, "*$1*")
		segment = underlinePattern.ReplaceAllString(segment, "_${1}_")
		segment = strikethroughPattern.ReplaceAllString(segment, "~$1~")
		return segment
	}))
}

func transformOutsideCode(text string, transform func(string) string) string {
	pattern := regexp.MustCompile("```[\\s\\S]*?```|`[^`\\n]+`")
	matches := pattern.FindAllStringIndex(text, -1)
	cursor := 0
	var builder strings.Builder
	for _, match := range matches {
		builder.WriteString(transform(text[cursor:match[0]]))
		builder.WriteString(text[match[0]:match[1]])
		cursor = match[1]
	}
	builder.WriteString(transform(text[cursor:]))
	return builder.String()
}
