package entity

import (
	"encoding/json"
	"errors"
	"reflect"
	"slices"
	"strings"
	"testing"

	"github.com/google/uuid"

	"github.com/digitalis-io/pulsus-dash/server/internal/core"
)

// The T24 §10.2 bindings, entities and scopes.
var (
	e1 = uuid.MustParse("00000000-0000-4000-8000-0000000000e1")
	e2 = uuid.MustParse("00000000-0000-4000-8000-0000000000e2")
)

type namedEntity struct {
	name    string
	binding uuid.UUID
	kind    string
	attrs   map[string]string
}

var entities = []namedEntity{
	{"checkout@e1", e1, "service", map[string]string{"service.name": "checkout"}},
	{"checkout@e2", e2, "service", map[string]string{"service.name": "checkout"}},
	{"payments@e1", e1, "service", map[string]string{"service.name": "payments", "service.namespace": "shop"}},
	{"gateway@e1", e1, "service", map[string]string{"service.name": "gateway"}},
	{"pod", e1, "pod", map[string]string{"k8s.cluster.name": "prod-eu-1", "k8s.namespace.name": "shop", "k8s.pod.name": "checkout-7d9f"}},
	{"env prod", e1, "environment", map[string]string{"deployment.environment.name": "prod"}},
	{"env stage", e1, "environment", map[string]string{"deployment.environment": "stage"}},
	{"cluster A", e1, "cluster", map[string]string{"k8s.cluster.name": "prod-eu-1"}},
	{"cluster B", e1, "cluster", map[string]string{"k8s.cluster.uid": "c-9f2"}},
}

// stored canonicalises a named entity as the service stores it.
func stored(t *testing.T, n namedEntity) *core.AnnotationEntity {
	t.Helper()
	raw := map[string]json.RawMessage{}
	for k, v := range n.attrs {
		b, _ := json.Marshal(v)
		raw[k] = b
	}
	c, err := Canonicalise(n.kind, raw)
	if err != nil {
		t.Fatalf("%s: %v", n.name, err)
	}
	return &core.AnnotationEntity{ID: ID(n.binding, c), BindingID: n.binding, Binding: "b", CanonicalEntity: c}
}

type namedScope struct {
	name    string
	clauses []core.ScopeClause
	covers  []string // the entities it covers; nil with denied
	denied  bool
}

func attrs(kv ...any) map[string][]string {
	out := map[string][]string{}
	for i := 0; i < len(kv); i += 2 {
		out[kv[i].(string)] = kv[i+1].([]string)
	}
	return out
}

var scopes = []namedScope{
	{"P_eu", []core.ScopeClause{{Bindings: []uuid.UUID{e1}}},
		[]string{"checkout@e1", "payments@e1", "gateway@e1", "pod", "env prod", "env stage", "cluster A", "cluster B"}, false},
	{"P_shop", []core.ScopeClause{{Attrs: attrs("service.namespace", []string{"shop"})}}, []string{"payments@e1"}, false},
	{"S1", []core.ScopeClause{{Bindings: []uuid.UUID{e2}}, {Attrs: attrs("service.namespace", []string{"shop"})}},
		[]string{"checkout@e2", "payments@e1"}, false},
	{"S2", []core.ScopeClause{{Bindings: []uuid.UUID{e1}, Attrs: attrs("service.name", []string{"checkout", "gateway"})}},
		[]string{"checkout@e1", "gateway@e1"}, false},
	{"S3", []core.ScopeClause{{Attrs: attrs("k8s.namespace.name", []string{"shop"})}}, []string{"pod"}, false},
	{"S4", []core.ScopeClause{{Attrs: attrs("service.namespace", []string{"shop", ""})}}, []string{"payments@e1"}, false},
	{"S5", []core.ScopeClause{{Attrs: attrs("service.name", []string{"checkout"})}}, []string{"checkout@e1", "checkout@e2"}, false},
	{"S6", []core.ScopeClause{{Bindings: []uuid.UUID{}}}, nil, true},
	{"T1", []core.ScopeClause{{Attrs: attrs("deployment.environment.name", []string{"prod"}, "deployment.environment", []string{"stage"})}}, []string{}, false},
	{"T2", []core.ScopeClause{{Attrs: attrs("deployment.environment.name", []string{"prod", "stage"}, "deployment.environment", []string{"prod", "dev"})}},
		[]string{"env prod"}, false},
	{"T3", []core.ScopeClause{{Attrs: attrs("k8s.cluster.name", []string{"prod-eu-1"})}}, []string{"pod", "cluster A"}, false},
}

func scopeByName(name string) namedScope {
	for _, s := range scopes {
		if s.name == name {
			return s
		}
	}
	panic(name)
}

// compiledJSON is the compiled scope as generic JSON.
func compiledJSON(t *testing.T, c Compiled) []any {
	t.Helper()
	b := c.JSON()
	if strings.Contains(string(b), "null") {
		t.Errorf("JSON() holds null: %s", b)
	}
	var out []any
	if err := json.Unmarshal(b, &out); err != nil {
		t.Fatalf("JSON() = %s: %v", b, err)
	}
	return out
}

func sameJSON(t *testing.T, got []any, want string) bool {
	t.Helper()
	var w []any
	if err := json.Unmarshal([]byte(want), &w); err != nil {
		t.Fatal(err)
	}
	return reflect.DeepEqual(got, w)
}

func TestCompileScope(t *testing.T) {
	for _, s := range scopes {
		c, err := CompileScope(s.clauses)
		if s.denied {
			if !errors.Is(err, core.ErrScopeDenied) {
				t.Errorf("%s: CompileScope = %v, %v; want ErrScopeDenied", s.name, c, err)
			}
			continue
		}
		if err != nil {
			t.Fatalf("%s: %v", s.name, err)
		}
		_ = compiledJSON(t, c)
	}
	compile := func(name string) []any {
		c, err := CompileScope(scopeByName(name).clauses)
		if err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		return compiledJSON(t, c)
	}
	if got := compile("T1"); !sameJSON(t, got, `[{"k":"environment","a":{"deployment.environment.name":[]}}]`) {
		t.Errorf("T1 = %s", js(got))
	}
	if got := compile("T2"); !sameJSON(t, got, `[{"k":"environment","a":{"deployment.environment.name":["prod"]}}]`) {
		t.Errorf("T2 = %s", js(got))
	}
	t3 := `[{"k":"cluster","a":{"k8s.cluster.uid":["prod-eu-1"]}},{"k":"namespace","a":{"k8s.cluster.name":["prod-eu-1"]}},` +
		`{"k":"node","a":{"k8s.cluster.name":["prod-eu-1"]}},{"k":"pod","a":{"k8s.cluster.name":["prod-eu-1"]}},` +
		`{"k":"workload","a":{"k8s.cluster.name":["prod-eu-1"]}}]`
	if got := compile("T3"); !sameJSON(t, got, t3) {
		t.Errorf("T3 = %s", js(got))
	}
	eu := compile("P_eu")
	if len(eu) != 19 {
		t.Errorf("P_eu compiles to %d clauses, want 19", len(eu))
	}
	for _, x := range eu {
		m, _ := x.(map[string]any)
		if !reflect.DeepEqual(m["b"], []any{e1.String()}) || !reflect.DeepEqual(m["a"], map[string]any{}) {
			t.Errorf("P_eu clause %s, want b [e1] and a {}", js(x))
		}
	}
	if got := string(Compiled(nil).JSON()); got != "[]" {
		t.Errorf("empty JSON() = %s, want []", got)
	}
	if got := string(Compiled{}.JSON()); got != "[]" {
		t.Errorf("empty JSON() = %s, want []", got)
	}
}

func TestScopeCovers(t *testing.T) {
	for _, s := range scopes {
		if s.denied {
			continue
		}
		c, err := CompileScope(s.clauses)
		if err != nil {
			t.Fatalf("%s: %v", s.name, err)
		}
		got := []string{}
		for _, n := range entities {
			if ScopeCovers(false, c, stored(t, n)) {
				got = append(got, n.name)
			}
		}
		if !slices.Equal(got, s.covers) {
			t.Errorf("%s covers %v, want %v", s.name, got, s.covers)
		}
		if ScopeCovers(false, c, nil) {
			t.Errorf("%s covers the organisation-wide nil", s.name)
		}
	}
	full, err := CompileScope(nil)
	if err != nil || len(full) != 0 {
		t.Fatalf("full scope compiles to %v, %v; want no clauses", full, err)
	}
	for _, n := range entities {
		if !ScopeCovers(true, full, stored(t, n)) {
			t.Errorf("full scope does not cover %s", n.name)
		}
	}
	if !ScopeCovers(true, full, nil) {
		t.Error("full scope does not cover the organisation-wide nil")
	}
	if ScopeCovers(false, full, stored(t, entities[0])) {
		t.Error("an empty scoped Compiled covers checkout@e1")
	}
}
