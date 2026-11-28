package core

import (
	"fmt"
	"slices"
	"strconv"
	"strings"

	"github.com/google/uuid"
	"github.com/zeebo/xxh3"
)

// BootstrapSeed is the first organisation and tenant binding that migrate writes on an empty
// database. It comes from the seed keys of the configuration (datasource.*, bootstrap.*).
type BootstrapSeed struct {
	OrgSlug, OrgName string
	Binding          BindingSeed
}

// BindingSeed is the seeded tenant binding. An empty string is stored as NULL. CredentialsRef is a
// secret reference (env:NAME or file:/path), never a resolved value (T19-010).
type BindingSeed struct {
	Slug, DatasourceURL, Database, ScopeOrgID, CredentialsRef string
}

// TenantBinding is a row of tenant_bindings: the authoritative PulsusDB binding of an organisation
// (T19-010). An empty string means NULL. CredentialsRef is the reference string, never a value.
type TenantBinding struct {
	OrgID                                                           OrgID
	ID                                                              uuid.UUID
	Slug, DatasourceURL, Database, ScopeOrgID, CredentialsRef, Kind string
	// ScopeSeq orders the binding's access-determining versions (#304 §A.2, ADR-0038).
	ScopeSeq int64
}

// ScopeEpoch is the effective data-scope version of (principal, binding, scope) as 16 lower-case
// hex (#304 §A.2, ADR-0038): xxh3-64 (seed 0) over, each followed by 0xFF, the principal, the
// binding ID, xxh3 of the datasource URL as hex, the database, the scope org ID, xxh3 of the
// credentials reference as hex ("" when null), the kind and the scope's canonical text. The
// endpoint and the reference enter only as hashes, so the epoch discloses neither; a credential
// rotated under the same reference changes nothing (owner decision 2026-11-27). The slug and
// ScopeSeq are not inputs: the sequence orders epochs, it does not make them.
func ScopeEpoch(principal string, b TenantBinding, s DataScope) string {
	hexOf := func(v string) string {
		if v == "" {
			return ""
		}
		return strconv.FormatUint(xxh3.HashString(v), 16)
	}
	parts := []string{principal, b.ID.String(), hexOf(b.DatasourceURL), b.Database, b.ScopeOrgID,
		hexOf(b.CredentialsRef), b.Kind, s.Canonical()}
	n := 0
	for _, p := range parts {
		n += len(p) + 1
	}
	buf := make([]byte, 0, n)
	for _, p := range parts {
		buf = append(buf, p...)
		buf = append(buf, 0xFF)
	}
	return fmt.Sprintf("%016x", xxh3.Hash(buf))
}

// Canonical is the scope's canonical text for the epoch (#304 §A.2): "full", "unset", or the
// clauses' canonical texts sorted and joined by 0x1E. A clause is its binding IDs sorted ("*" for
// any binding) and its attributes sorted by key, each value list sorted, every string length-
// prefixed so that no two scopes share a text.
func (s DataScope) Canonical() string {
	switch {
	case !s.set:
		return "unset"
	case s.full:
		return "full"
	}
	lp := func(b *strings.Builder, v string) {
		b.WriteString(strconv.Itoa(len(v)))
		b.WriteByte(':')
		b.WriteString(v)
	}
	texts := make([]string, 0, len(s.clauses))
	for _, c := range s.clauses {
		var b strings.Builder
		if c.Bindings == nil {
			b.WriteString("*")
		} else {
			ids := make([]string, 0, len(c.Bindings))
			for _, id := range c.Bindings {
				ids = append(ids, id.String())
			}
			slices.Sort(ids)
			b.WriteString("[")
			for _, id := range ids {
				lp(&b, id)
			}
			b.WriteString("]")
		}
		keys := make([]string, 0, len(c.Attrs))
		for k := range c.Attrs {
			keys = append(keys, k)
		}
		slices.Sort(keys)
		for _, k := range keys {
			vs := slices.Clone(c.Attrs[k])
			slices.Sort(vs)
			b.WriteString("{")
			lp(&b, k)
			for _, v := range vs {
				lp(&b, v)
			}
			b.WriteString("}")
		}
		texts = append(texts, b.String())
	}
	slices.Sort(texts)
	return strings.Join(texts, "\x1e")
}
