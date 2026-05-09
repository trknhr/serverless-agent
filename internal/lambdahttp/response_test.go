package lambdahttp

import (
	"net/http"
	"testing"
)

func TestJSONResponse(t *testing.T) {
	response := JSON(http.StatusCreated, map[string]any{"ok": true, "count": 2})

	if response.StatusCode != http.StatusCreated {
		t.Fatalf("StatusCode = %d, want %d", response.StatusCode, http.StatusCreated)
	}
	if response.Headers["content-type"] != "application/json; charset=utf-8" {
		t.Fatalf("unexpected content-type: %q", response.Headers["content-type"])
	}
	if response.Body != `{"count":2,"ok":true}` {
		t.Fatalf("Body = %q", response.Body)
	}
}

func TestJSONResponseMarshalError(t *testing.T) {
	response := JSON(http.StatusOK, map[string]any{"bad": make(chan int)})

	if response.StatusCode != http.StatusInternalServerError {
		t.Fatalf("StatusCode = %d, want %d", response.StatusCode, http.StatusInternalServerError)
	}
	if response.Body != `{"ok":false,"error":"marshal_error"}` {
		t.Fatalf("Body = %q", response.Body)
	}
}

func TestTextHTMLAndRedirectResponses(t *testing.T) {
	text := Text(http.StatusAccepted, "plain")
	if text.Headers["content-type"] != "text/plain; charset=utf-8" || text.Body != "plain" {
		t.Fatalf("unexpected text response: %#v", text)
	}

	html := HTML(http.StatusOK, "<p>ok</p>")
	if html.Headers["content-type"] != "text/html; charset=utf-8" || html.Body != "<p>ok</p>" {
		t.Fatalf("unexpected html response: %#v", html)
	}

	redirect := Redirect("https://example.com")
	if redirect.StatusCode != http.StatusFound || redirect.Headers["location"] != "https://example.com" || redirect.Body != "" {
		t.Fatalf("unexpected redirect response: %#v", redirect)
	}
}
