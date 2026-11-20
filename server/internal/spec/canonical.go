package spec

import (
	"bytes"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"io"
)

// Canonical returns the canonical JSON of v (plan #61 §3.4.2): v is marshalled (a []byte or
// json.RawMessage is taken as JSON text), decoded with numbers kept as written, and encoded again
// with object keys sorted, no HTML escaping and no trailing newline. It is the form of the stored
// spec, content_hash, the audit diff and the audit hash input; Canonical of the jsonb read back
// from Postgres equals Canonical of what was written.
func Canonical(v any) ([]byte, error) {
	var raw []byte
	switch x := v.(type) {
	case []byte:
		raw = x
	case json.RawMessage:
		raw = x
	default:
		var err error
		if raw, err = json.Marshal(v); err != nil {
			return nil, fmt.Errorf("spec: canonical: %w", err)
		}
	}
	t, err := decodeValue(raw)
	if err != nil {
		return nil, err
	}
	return encodeValue(t)
}

// decodeValue decodes exactly one JSON value, keeping numbers as json.Number.
func decodeValue(raw []byte) (any, error) {
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	var t any
	if err := dec.Decode(&t); err != nil {
		return nil, fmt.Errorf("spec: canonical: %w", err)
	}
	if _, err := dec.Token(); !errors.Is(err, io.EOF) {
		return nil, errors.New("spec: canonical: trailing data after the JSON value")
	}
	return t, nil
}

func encodeValue(t any) ([]byte, error) {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(t); err != nil {
		return nil, fmt.Errorf("spec: canonical: %w", err)
	}
	return bytes.TrimSuffix(buf.Bytes(), []byte("\n")), nil
}

// ContentHash is the SHA-256 of a canonical spec (board_versions.content_hash, T11-006).
func ContentHash(canon []byte) [32]byte { return sha256.Sum256(canon) }
