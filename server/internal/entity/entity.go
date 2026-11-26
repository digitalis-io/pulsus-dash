// Package entity is the annotation entity's identity and data scope (T24 §5.9): the T12 §4.2
// kind table, canonicalisation and EntityId (T12-010), and the per-kind scope compiler with
// ScopeCovers (T12-018). It is pure: no I/O.
package entity

import (
	"encoding/json"
	"errors"

	"github.com/google/uuid"

	"github.com/digitalis-io/pulsus-dash/server/internal/core"
)

// ErrInvalid is a submitted entity that does not canonicalise (400 annotations.entity.invalid).
var ErrInvalid = errors.New("entity: invalid")

// Canonicalise is not implemented yet (#222 tests first).
func Canonicalise(kind string, attrs map[string]json.RawMessage) (core.CanonicalEntity, error) {
	return core.CanonicalEntity{}, nil
}

// Canon is not implemented yet.
func Canon(binding uuid.UUID, c core.CanonicalEntity) []byte { return nil }

// ID is not implemented yet.
func ID(binding uuid.UUID, c core.CanonicalEntity) uuid.UUID { return uuid.UUID{} }
