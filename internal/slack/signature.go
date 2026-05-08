package slack

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"strconv"
	"time"
)

type VerifySignatureInput struct {
	RawBody       string
	Signature     string
	Timestamp     string
	SigningSecret string
}

func VerifySignature(input VerifySignatureInput) bool {
	if input.Signature == "" || input.Timestamp == "" {
		return false
	}

	requestTimestamp, err := strconv.ParseInt(input.Timestamp, 10, 64)
	if err != nil {
		return false
	}

	ageSeconds := time.Now().Unix() - requestTimestamp
	if ageSeconds < 0 {
		ageSeconds = -ageSeconds
	}
	if ageSeconds > 60*5 {
		return false
	}

	base := fmt.Sprintf("v0:%s:%s", input.Timestamp, input.RawBody)
	mac := hmac.New(sha256.New, []byte(input.SigningSecret))
	mac.Write([]byte(base))
	expected := "v0=" + hex.EncodeToString(mac.Sum(nil))

	return hmac.Equal([]byte(input.Signature), []byte(expected))
}
