package anthropic

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestClientRequestSendsHeadersAndDecodesResponse(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			t.Fatalf("method = %s, want POST", r.Method)
		}
		if r.URL.Path != "/v1/test" {
			t.Fatalf("path = %s, want /v1/test", r.URL.Path)
		}
		if r.Header.Get("x-api-key") != "test-key" {
			t.Fatalf("missing x-api-key header")
		}
		if r.Header.Get("anthropic-version") != "2023-06-01" || r.Header.Get("anthropic-beta") != "test-beta" {
			t.Fatalf("unexpected anthropic headers: version=%q beta=%q", r.Header.Get("anthropic-version"), r.Header.Get("anthropic-beta"))
		}

		var payload map[string]string
		if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
			t.Fatalf("decode request body: %v", err)
		}
		if payload["hello"] != "world" {
			t.Fatalf("unexpected payload: %#v", payload)
		}

		w.Header().Set("content-type", "application/json")
		_, _ = w.Write([]byte(`{"id":"ok"}`))
	}))
	defer server.Close()

	client := NewClient(func(context.Context) (string, error) { return "test-key", nil }, "test-beta")
	client.apiBaseURL = server.URL

	var response struct {
		ID string `json:"id"`
	}
	if err := client.Request(context.Background(), http.MethodPost, "/v1/test", map[string]string{"hello": "world"}, &response); err != nil {
		t.Fatalf("Request returned error: %v", err)
	}
	if response.ID != "ok" {
		t.Fatalf("response.ID = %q, want ok", response.ID)
	}
}

func TestClientRequestReturnsAPIError(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "bad request", http.StatusBadRequest)
	}))
	defer server.Close()

	client := NewClient(func(context.Context) (string, error) { return "test-key", nil }, "test-beta")
	client.apiBaseURL = server.URL

	err := client.Request(context.Background(), http.MethodGet, "/v1/test", nil, nil)
	if err == nil {
		t.Fatal("expected error")
	}
	apiErr, ok := err.(*APIError)
	if !ok {
		t.Fatalf("error type = %T, want *APIError", err)
	}
	if apiErr.Status != http.StatusBadRequest || apiErr.Payload == "" {
		t.Fatalf("unexpected api error: %#v", apiErr)
	}
}

func TestCreateSessionBuildsMemoryResources(t *testing.T) {
	var requestPayload map[string]any
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/sessions" {
			t.Fatalf("path = %s, want /v1/sessions", r.URL.Path)
		}
		if err := json.NewDecoder(r.Body).Decode(&requestPayload); err != nil {
			t.Fatalf("decode request: %v", err)
		}
		_, _ = w.Write([]byte(`{"id":"session_123","status":"active"}`))
	}))
	defer server.Close()

	client := NewClient(func(context.Context) (string, error) { return "test-key", nil }, "beta")
	client.apiBaseURL = server.URL

	result, err := CreateSession(context.Background(), client, CreateSessionInput{
		AgentID:       "agent_123",
		EnvironmentID: "env_123",
		VaultIDs:      []string{"vlt_123"},
		Title:         "Slack thread",
		Metadata:      map[string]string{"channel": "C123"},
		MemoryResources: []SessionMemoryResource{
			{MemoryStoreID: "mem_1", Prompt: "remember"},
			{MemoryStoreID: "mem_2", Access: "read_only", Prompt: "read"},
		},
	})
	if err != nil {
		t.Fatalf("CreateSession returned error: %v", err)
	}
	if result.ID != "session_123" || result.Status != "active" {
		t.Fatalf("unexpected result: %#v", result)
	}

	resources := requestPayload["resources"].([]any)
	first := resources[0].(map[string]any)
	second := resources[1].(map[string]any)
	if first["access"] != "read_write" || second["access"] != "read_only" {
		t.Fatalf("unexpected resource access defaults: %#v", resources)
	}
}
