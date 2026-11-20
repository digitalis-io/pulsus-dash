package boards

import (
	"crypto/rand"
	"fmt"
)

const (
	uidAlphabet = "0123456789abcdefghijklmnopqrstuvwxyz"
	uidLength   = 14
	// uidLimit is the largest multiple of 36 below 256: bytes at or above it are rejected so that
	// every character is equally likely.
	uidLimit = 252
)

// NewUID returns a board uid: 14 characters of [0-9a-z] from crypto/rand, rejection-sampled
// (about 72 bits).
func NewUID() (string, error) {
	out := make([]byte, 0, uidLength)
	var buf [32]byte
	for len(out) < uidLength {
		if _, err := rand.Read(buf[:]); err != nil {
			return "", fmt.Errorf("boards: random uid: %w", err)
		}
		for _, b := range buf {
			if b < uidLimit && len(out) < uidLength {
				out = append(out, uidAlphabet[b%36])
			}
		}
	}
	return string(out), nil
}
