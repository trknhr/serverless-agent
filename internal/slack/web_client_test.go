package slack

import (
	"encoding/json"
	"testing"
)

func TestPostMessagePayloadOmitsEmptyThreadTS(t *testing.T) {
	payload := postMessagePayload("C123", "hello", "")

	if _, ok := payload["thread_ts"]; ok {
		t.Fatalf("expected thread_ts to be omitted, got %#v", payload["thread_ts"])
	}

	body, err := json.Marshal(payload)
	if err != nil {
		t.Fatalf("marshal payload: %v", err)
	}
	if string(body) != `{"channel":"C123","text":"hello"}` {
		t.Fatalf("unexpected JSON payload: %s", body)
	}
}

func TestPostMessagePayloadIncludesThreadTSWhenPresent(t *testing.T) {
	payload := postMessagePayload("C123", "hello", "1720000000.000100")

	if payload["thread_ts"] != "1720000000.000100" {
		t.Fatalf("thread_ts = %#v, want timestamp", payload["thread_ts"])
	}
}
