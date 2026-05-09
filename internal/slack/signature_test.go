package slack

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"testing"
	"time"
)

func TestVerifySignature(t *testing.T) {
	timestamp := fmt.Sprintf("%d", time.Now().Unix())
	body := `{"type":"event_callback"}`
	secret := "signing-secret"
	signature := testSlackSignature(secret, timestamp, body)

	if !VerifySignature(VerifySignatureInput{RawBody: body, Signature: signature, Timestamp: timestamp, SigningSecret: secret}) {
		t.Fatal("expected valid signature")
	}
	if VerifySignature(VerifySignatureInput{RawBody: body + "x", Signature: signature, Timestamp: timestamp, SigningSecret: secret}) {
		t.Fatal("expected modified body to fail signature verification")
	}
}

func TestVerifySignatureRejectsInvalidInputs(t *testing.T) {
	staleTimestamp := fmt.Sprintf("%d", time.Now().Add(-10*time.Minute).Unix())
	body := "payload"
	secret := "secret"

	tests := []VerifySignatureInput{
		{RawBody: body, Signature: "", Timestamp: staleTimestamp, SigningSecret: secret},
		{RawBody: body, Signature: "v0=bad", Timestamp: "", SigningSecret: secret},
		{RawBody: body, Signature: "v0=bad", Timestamp: "not-a-time", SigningSecret: secret},
		{RawBody: body, Signature: testSlackSignature(secret, staleTimestamp, body), Timestamp: staleTimestamp, SigningSecret: secret},
	}

	for _, input := range tests {
		if VerifySignature(input) {
			t.Fatalf("expected signature verification to fail for %#v", input)
		}
	}
}

func testSlackSignature(secret string, timestamp string, body string) string {
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte("v0:" + timestamp + ":" + body))
	return "v0=" + hex.EncodeToString(mac.Sum(nil))
}
