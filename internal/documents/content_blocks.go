package documents

import (
	"encoding/base64"
	"strings"

	"github.com/trknhr/slack-ai-assistant/internal/anthropic"
)

func BuildClaudeContentBlocksForDocument(title string, mimeType string, content []byte) []anthropic.InputBlock {
	if mimeType == "application/pdf" {
		return []anthropic.InputBlock{
			{
				"type":  "document",
				"title": title,
				"source": map[string]any{
					"type":       "base64",
					"media_type": "application/pdf",
					"data":       base64.StdEncoding.EncodeToString(content),
				},
			},
		}
	}
	if len(mimeType) >= 6 && mimeType[:6] == "image/" {
		return []anthropic.InputBlock{
			{
				"type": "text",
				"text": "Attached image: " + title,
			},
			{
				"type": "image",
				"source": map[string]any{
					"type":       "base64",
					"media_type": mimeType,
					"data":       base64.StdEncoding.EncodeToString(content),
				},
			},
		}
	}
	if isTextLikeMimeType(mimeType) {
		return []anthropic.InputBlock{
			{
				"type":  "document",
				"title": title,
				"source": map[string]any{
					"type":       "text",
					"media_type": "text/plain",
					"data":       string(content),
				},
			},
		}
	}
	return []anthropic.InputBlock{
		{
			"type": "text",
			"text": "Attachment note: " + title + " (" + chooseMimeType(mimeType) + ") is not supported for inline analysis.",
		},
	}
}

func chooseMimeType(value string) string {
	if value == "" {
		return "unknown mime type"
	}
	return value
}

func isTextLikeMimeType(mimeType string) bool {
	return strings.HasPrefix(mimeType, "text/") ||
		mimeType == "application/json" ||
		mimeType == "application/xml" ||
		mimeType == "application/javascript"
}
