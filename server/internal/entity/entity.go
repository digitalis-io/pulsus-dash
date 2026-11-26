// Package entity is the annotation entity's identity and data scope (T24 §5.9): the T12 §4.2
// kind table, canonicalisation and EntityId (T12-010), and the per-kind scope compiler with
// ScopeCovers (T12-018). It is pure: no I/O.
package entity

import (
	"encoding/binary"
	"encoding/json"
	"errors"
	"strings"
	"unicode/utf8"

	"github.com/google/uuid"
	"github.com/zeebo/xxh3"

	"github.com/digitalis-io/pulsus-dash/server/internal/core"
)

// ErrInvalid is a submitted entity that does not canonicalise (400 annotations.entity.invalid).
var ErrInvalid = errors.New("entity: invalid")

// maxValueLen is the longest attribute value, in code points.
const maxValueLen = 256

// value decodes an attribute value: a JSON string of 1–256 code points without U+0000 (jsonb
// cannot hold it).
func value(raw json.RawMessage) (string, bool) {
	t := strings.TrimSpace(string(raw))
	if !strings.HasPrefix(t, `"`) {
		return "", false
	}
	var s string
	if err := json.Unmarshal(raw, &s); err != nil {
		return "", false
	}
	n := utf8.RuneCountInString(s)
	if n < 1 || n > maxValueLen || strings.ContainsRune(s, 0) {
		return "", false
	}
	return s, true
}

// Canonicalise maps a submitted kind and attribute map to the canonical entity (T12-010): every
// key must be an alternative of one of the kind's positions and every value a non-empty string;
// a position takes its present alternative (several present must be equal), else its literal,
// else it is absent if optional, else the entity is invalid. Any failure is ErrInvalid.
func Canonicalise(kind string, attrs map[string]json.RawMessage) (core.CanonicalEntity, error) {
	k, ok := Kinds[kind]
	if !ok {
		return core.CanonicalEntity{}, ErrInvalid
	}
	chosen := make([]*string, len(k.Positions))
	for key, raw := range attrs {
		i := k.position(key)
		if i < 0 {
			return core.CanonicalEntity{}, ErrInvalid
		}
		v, ok := value(raw)
		if !ok {
			return core.CanonicalEntity{}, ErrInvalid
		}
		if chosen[i] != nil && *chosen[i] != v {
			return core.CanonicalEntity{}, ErrInvalid
		}
		chosen[i] = &v
	}
	out := core.CanonicalEntity{Kind: kind, Ident: make([]*string, len(k.Positions)), Attrs: map[string]string{}}
	for i, p := range k.Positions {
		v := chosen[i]
		switch {
		case v != nil:
		case p.Literal != "":
			l := p.Literal
			v = &l
		case p.Optional:
			continue
		default:
			return core.CanonicalEntity{}, ErrInvalid
		}
		out.Ident[i] = v
		out.Attrs[p.Alts[0]] = *v
	}
	return out, nil
}

// enc is 0x01 ‖ uvarint(len x) ‖ x.
func enc(b []byte, x []byte) []byte {
	b = append(b, 0x01)
	b = binary.AppendUvarint(b, uint64(len(x)))
	return append(b, x...)
}

// Canon is the canonical byte string of T12-010: enc(binding's 16 bytes) ‖ enc(kind) ‖, per
// identifying position in schema order, enc(value) or 0x00 when absent.
func Canon(binding uuid.UUID, c core.CanonicalEntity) []byte {
	b := enc(nil, binding[:])
	b = enc(b, []byte(c.Kind))
	for _, v := range c.Ident {
		if v == nil {
			b = append(b, 0x00)
			continue
		}
		b = enc(b, []byte(*v))
	}
	return b
}

// ID is the EntityId (T12-010): the XXH3-128 of Canon, the high 64 bits then the low 64 bits,
// big-endian.
func ID(binding uuid.UUID, c core.CanonicalEntity) uuid.UUID {
	h := xxh3.Hash128(Canon(binding, c))
	var u uuid.UUID
	binary.BigEndian.PutUint64(u[:8], h.Hi)
	binary.BigEndian.PutUint64(u[8:], h.Lo)
	return u
}
