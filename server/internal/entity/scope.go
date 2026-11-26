package entity

import (
	"github.com/digitalis-io/pulsus-dash/server/internal/core"
)

// Clause is one compiled scope clause (T24 §5.9) for one kind: K the kind, B the allowed binding
// ids (lower case; absent = any binding) and A, per canonical position name, the allowed values
// (an empty list matches nothing).
type Clause struct {
	K string              `json:"k"`
	B []string            `json:"b,omitempty"`
	A map[string][]string `json:"a"`
}

// Compiled is a compiled data scope: its clauses are OR-ed. The SQL predicate P reads its JSON
// and ScopeCovers reads it directly, so the two cannot disagree on a canonical map.
type Compiled []Clause

// CompileScope is not implemented yet.
func CompileScope(clauses []core.ScopeClause) (Compiled, error) { return Compiled{}, nil }

// JSON is not implemented yet.
func (c Compiled) JSON() []byte { return []byte("[]") }

// ScopeCovers is not implemented yet.
func ScopeCovers(full bool, c Compiled, e *core.AnnotationEntity) bool { return false }
