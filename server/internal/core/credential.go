package core

import (
	"strconv"
	"strings"
)

// MinPasswordBytes is the shortest PulsusDB password accepted (plan #62 §4.10).
const MinPasswordBytes = 8

// WeakPassword reports whether p is refused as a PulsusDB password: shorter than 8 bytes, or a
// text that strconv.ParseFloat accepts, as given or with surrounding spaces trimmed. That covers
// signs, decimals, exponents, hex floats, Inf, NaN and underscores, so no accepted password can
// equal an upstream sample value, which the BFF parses as a number and never redacts (§4.9).
// The client, the migrate seed and config check use this one function.
func WeakPassword(p string) bool {
	if len(p) < MinPasswordBytes {
		return true
	}
	if _, err := strconv.ParseFloat(p, 64); err == nil {
		return true
	}
	_, err := strconv.ParseFloat(strings.TrimSpace(p), 64)
	return err == nil
}
