package entity

import (
	"encoding/json"
	"slices"
	"sort"

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

// kindNames are the kinds of Kinds by name.
var kindNames = func() []string {
	out := make([]string, 0, len(Kinds))
	for n := range Kinds {
		out = append(out, n)
	}
	sort.Strings(out)
	return out
}()

// CompileScope compiles the clauses per kind (T24 §5.9): a key with no position in a kind drops
// the clause for it; keys on one position intersect their values under the position's first
// alternative; B lists the clause's bindings. A clause with a non-nil empty Bindings allows
// nothing and is core.ErrScopeDenied. The order is clause, then kind by name.
func CompileScope(clauses []core.ScopeClause) (Compiled, error) {
	out := Compiled{}
	for _, cl := range clauses {
		if cl.Bindings != nil && len(cl.Bindings) == 0 {
			return nil, core.ErrScopeDenied
		}
		var b []string
		if cl.Bindings != nil {
			b = make([]string, 0, len(cl.Bindings))
			for _, id := range cl.Bindings {
				b = append(b, id.String())
			}
		}
		keys := make([]string, 0, len(cl.Attrs))
		for k := range cl.Attrs {
			keys = append(keys, k)
		}
		sort.Strings(keys)
	kinds:
		for _, name := range kindNames {
			k := Kinds[name]
			a := map[string][]string{}
			for _, key := range keys {
				i := k.position(key)
				if i < 0 {
					continue kinds
				}
				canon := k.Positions[i].Alts[0]
				vals := sortedSet(cl.Attrs[key])
				if prev, ok := a[canon]; ok {
					vals = intersect(prev, vals)
				}
				a[canon] = vals
			}
			out = append(out, Clause{K: name, B: b, A: a})
		}
	}
	return out, nil
}

// sortedSet is vs sorted and deduplicated, never nil.
func sortedSet(vs []string) []string {
	out := append([]string{}, vs...)
	slices.Sort(out)
	return slices.Compact(out)
}

// intersect is the sorted intersection of two sorted sets, never nil.
func intersect(a, b []string) []string {
	out := []string{}
	for _, x := range a {
		if _, ok := slices.BinarySearch(b, x); ok {
			out = append(out, x)
		}
	}
	return out
}

// JSON is the $scope parameter of the predicate P. It never holds a JSON null (`null @> …` is
// NULL, which would fail open under NOT): an empty scope is [] and every A value is an array.
func (c Compiled) JSON() []byte {
	if len(c) == 0 {
		return []byte("[]")
	}
	b, err := json.Marshal(c)
	if err != nil {
		// Marshalling strings, string slices and maps of them cannot fail.
		return []byte("[]")
	}
	return b
}

// ScopeCovers reports whether the scope covers an entity (the Go twin of P): full scope covers
// every entity and the organisation-wide nil; otherwise nil is not covered, and an entity is
// covered when some clause has its kind, holds its binding (or any binding), and lists the
// entity's canonical value of each of its positions.
func ScopeCovers(full bool, c Compiled, e *core.AnnotationEntity) bool {
	if full {
		return true
	}
	if e == nil {
		return false
	}
	binding := e.BindingID.String()
clauses:
	for _, cl := range c {
		if cl.K != e.Kind {
			continue
		}
		if cl.B != nil && !slices.Contains(cl.B, binding) {
			continue
		}
		for key, allowed := range cl.A {
			v, ok := e.Attrs[key]
			if !ok || !slices.Contains(allowed, v) {
				continue clauses
			}
		}
		return true
	}
	return false
}
