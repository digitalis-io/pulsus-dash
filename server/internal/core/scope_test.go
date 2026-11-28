package core

import (
	"regexp"
	"testing"

	"github.com/google/uuid"
)

// scope_epoch (#304 §A.2, ADR-0038): the epoch is 16 lower-case hex of the effective scope; a
// narrowed scope, a new endpoint, database, scope org, credential reference or kind each give a
// new one; a credential rotated under the same reference (the reference unchanged) gives the same.
func TestScopeEpoch(t *testing.T) {
	ref := "env:" + "PULSUS_TOKEN" // a reference string, never a credential (T19-010)
	b := TenantBinding{OrgID: OrgID(uuid.MustParse("01900000-0000-7000-8000-0000000000aa")),
		ID: uuid.MustParse("01900000-0000-7000-8000-000000000001"), Slug: "demo",
		DatasourceURL: "http://pulsus.invalid:9090", Kind: "pulsusdb", CredentialsRef: ref, ScopeSeq: 1}
	base := ScopeEpoch(LocalPrincipal.ID, b, FullTenantScope())
	if !regexp.MustCompile(`^[0-9a-f]{16}$`).MatchString(base) {
		t.Fatalf("epoch %q", base)
	}
	if again := ScopeEpoch(LocalPrincipal.ID, b, FullTenantScope()); again != base {
		t.Errorf("not stable: %q %q", base, again)
	}
	narrowed := ScopedTenant(ScopeClause{Attrs: map[string][]string{"team": {"a"}}})
	other := map[string]func(*TenantBinding){
		"datasource_url":  func(x *TenantBinding) { x.DatasourceURL = "http://other.invalid:9090" },
		"database":        func(x *TenantBinding) { x.Database = "db2" },
		"scope_org_id":    func(x *TenantBinding) { x.ScopeOrgID = "org-2" },
		"credentials_ref": func(x *TenantBinding) { x.CredentialsRef = "env:OTHER_TOKEN" },
		"kind":            func(x *TenantBinding) { x.Kind = "other" },
	}
	for name, mod := range other {
		x := b
		mod(&x)
		if ScopeEpoch(LocalPrincipal.ID, x, FullTenantScope()) == base {
			t.Errorf("%s: the epoch did not change", name)
		}
	}
	if ScopeEpoch(LocalPrincipal.ID, b, narrowed) == base {
		t.Error("a narrowed scope kept the epoch")
	}
	if ScopeEpoch("someone-else", b, FullTenantScope()) == base {
		t.Error("another principal kept the epoch")
	}
	// The slug and the sequence are not scope inputs.
	x := b
	x.Slug, x.ScopeSeq = "renamed", 9
	if ScopeEpoch(LocalPrincipal.ID, x, FullTenantScope()) != base {
		t.Error("the slug or the sequence changed the epoch")
	}
	// Clause and value order do not matter.
	c1 := ScopedTenant(ScopeClause{Attrs: map[string][]string{"team": {"a", "b"}}}, ScopeClause{Attrs: map[string][]string{"env": {"p"}}})
	c2 := ScopedTenant(ScopeClause{Attrs: map[string][]string{"env": {"p"}}}, ScopeClause{Attrs: map[string][]string{"team": {"b", "a"}}})
	if c1.Canonical() != c2.Canonical() {
		t.Errorf("canonical %q %q", c1.Canonical(), c2.Canonical())
	}
	if FullTenantScope().Canonical() != "full" || (DataScope{}).Canonical() != "unset" {
		t.Errorf("full %q unset %q", FullTenantScope().Canonical(), (DataScope{}).Canonical())
	}
}
