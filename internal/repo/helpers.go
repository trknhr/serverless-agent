package repo

import "github.com/trknhr/slack-ai-assistant/internal/idgen"

func fallbackID(value string, prefix string) string {
	if value != "" {
		return value
	}
	return idgen.New(prefix)
}

func derefFloat(value *float64) float64 {
	if value == nil {
		return 0
	}
	return *value
}
