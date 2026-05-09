package idgen

import (
	"crypto/rand"
	"encoding/hex"
)

func New(prefix string) string {
	buffer := make([]byte, 16)
	if _, err := rand.Read(buffer); err != nil {
		panic(err)
	}
	return prefix + hex.EncodeToString(buffer)
}
