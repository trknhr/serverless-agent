package config

import (
	"strings"
	"testing"
)

func TestParsePositiveInt(t *testing.T) {
	t.Setenv("TEST_POSITIVE_INT", "")
	value, err := parsePositiveInt("TEST_POSITIVE_INT", 42)
	if err != nil {
		t.Fatalf("parsePositiveInt returned error: %v", err)
	}
	if value != 42 {
		t.Fatalf("value = %d, want fallback 42", value)
	}

	t.Setenv("TEST_POSITIVE_INT", " 7 ")
	value, err = parsePositiveInt("TEST_POSITIVE_INT", 42)
	if err != nil {
		t.Fatalf("parsePositiveInt returned error: %v", err)
	}
	if value != 7 {
		t.Fatalf("value = %d, want 7", value)
	}

	for _, raw := range []string{"0", "-1", "abc"} {
		t.Run(raw, func(t *testing.T) {
			t.Setenv("TEST_POSITIVE_INT", raw)
			if _, err := parsePositiveInt("TEST_POSITIVE_INT", 42); err == nil {
				t.Fatal("expected error")
			}
		})
	}
}

func TestParseBool(t *testing.T) {
	trueInputs := []string{"1", "true", "TRUE", " yes ", "on"}
	for _, input := range trueInputs {
		if !parseBool(input) {
			t.Fatalf("parseBool(%q) = false, want true", input)
		}
	}

	falseInputs := []string{"", "0", "false", "off", "y"}
	for _, input := range falseInputs {
		if parseBool(input) {
			t.Fatalf("parseBool(%q) = true, want false", input)
		}
	}
}

func TestParseCSVTrimsAndDropsEmptyValues(t *testing.T) {
	got := parseCSV(" vlt_1, ,vlt_2 ,, vlt_3 ")
	want := []string{"vlt_1", "vlt_2", "vlt_3"}

	if strings.Join(got, ",") != strings.Join(want, ",") {
		t.Fatalf("parseCSV() = %#v, want %#v", got, want)
	}
}

func TestLoadBaseEnvDefaultsAndOverrides(t *testing.T) {
	setRequiredBaseEnv(t)
	t.Setenv("ANTHROPIC_VAULT_IDS", "vlt_1, vlt_2")
	t.Setenv("ENABLE_USER_MEMORY", "yes")
	t.Setenv("EVENT_DEDUP_TTL_SECONDS", "99")
	t.Setenv("AGENT_RESPONSE_TIMEOUT_MS", "1000")
	t.Setenv("TOP_LEVEL_CONTEXT_TURN_LIMIT", "4")
	t.Setenv("MAX_SLACK_FILE_BYTES", "1234")

	env, err := loadBaseEnv()
	if err != nil {
		t.Fatalf("loadBaseEnv returned error: %v", err)
	}

	if env.EventDedupTTLSeconds != 99 || env.AgentResponseTimeoutMS != 1000 || env.TopLevelContextTurnLimit != 4 || env.MaxSlackFileBytes != 1234 {
		t.Fatalf("unexpected numeric env values: %#v", env)
	}
	if !env.EnableUserMemory {
		t.Fatal("EnableUserMemory = false, want true")
	}
	if strings.Join(env.AnthropicVaultIDs, ",") != "vlt_1,vlt_2" {
		t.Fatalf("AnthropicVaultIDs = %#v", env.AnthropicVaultIDs)
	}
	if env.AnthropicManagedAgentsBeta != "managed-agents-2026-04-01" {
		t.Fatalf("unexpected beta default: %q", env.AnthropicManagedAgentsBeta)
	}
}

func TestMustGetRequiredPanicsWhenMissing(t *testing.T) {
	t.Setenv("MISSING_REQUIRED_TEST", " ")
	defer func() {
		if recover() == nil {
			t.Fatal("expected panic")
		}
	}()

	_ = mustGetRequired("MISSING_REQUIRED_TEST")
}

func setRequiredBaseEnv(t *testing.T) {
	t.Helper()
	required := map[string]string{
		"SESSION_TABLE_NAME":               "sessions",
		"CONVERSATION_SESSIONS_TABLE_NAME": "conversation-sessions",
		"CONVERSATION_TURNS_TABLE_NAME":    "conversation-turns",
		"USER_MEMORY_TABLE_NAME":           "user-memory",
		"MEMORY_ITEMS_TABLE_NAME":          "memory-items",
		"TASKS_TABLE_NAME":                 "tasks",
		"TASK_EVENTS_TABLE_NAME":           "task-events",
		"PROCESSED_EVENTS_TABLE_NAME":      "processed-events",
		"TASK_TABLE_NAME":                  "scheduled-tasks",
		"SLACK_SIGNING_SECRET_SECRET_ID":   "slack-signing-secret",
		"SLACK_BOT_TOKEN_SECRET_ID":        "slack-bot-token",
		"ANTHROPIC_API_KEY_SECRET_ID":      "anthropic-api-key",
		"ANTHROPIC_AGENT_ID":               "agent_123",
		"ANTHROPIC_ENVIRONMENT_ID":         "env_123",
		"DEFAULT_SCHEDULE_CHANNEL":         "C123",
		"ANTHROPIC_MANAGED_AGENTS_BETA":    "",
		"ANTHROPIC_VAULT_IDS":              "",
		"ENABLE_USER_MEMORY":               "",
		"EVENT_DEDUP_TTL_SECONDS":          "",
		"AGENT_RESPONSE_TIMEOUT_MS":        "",
		"TOP_LEVEL_CONTEXT_TURN_LIMIT":     "",
		"MAX_SLACK_FILE_BYTES":             "",
	}
	for key, value := range required {
		t.Setenv(key, value)
	}
}
