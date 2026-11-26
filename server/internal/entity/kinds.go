package entity

// Position is one identifying position of a kind (T12 §4.2): its alternatives in order (`a|b`,
// the first present is taken; the first names the position in the canonical map), a constant used
// when none is present (a quoted literal, "" = none), and whether it may be absent (`?`).
type Position struct {
	Alts     []string
	Literal  string
	Optional bool
}

// Kind is an entity kind of the T12 §4.2 kind table: its name and identifying positions in schema
// order.
type Kind struct {
	Name      string
	Positions []Position
}

func req(alts ...string) Position { return Position{Alts: alts} }

func opt(alts ...string) Position { return Position{Alts: alts, Optional: true} }

func kind(name string, ps ...Position) Kind { return Kind{Name: name, Positions: ps} }

// SchemaVersion is the version of the T12 §4.2 kind table that Kinds holds.
const SchemaVersion = 8

// Kinds is the T12 §4.2 kind table, version 8: the 19 kinds as written. The kinds the table only
// names in a comment (hall, node_pool, control_plane, hypervisor_host, device …) are absent, so
// they are unknown kinds.
var Kinds = map[string]Kind{
	"environment":  kind("environment", req("deployment.environment.name", "deployment.environment")),
	"provider":     kind("provider", Position{Alts: []string{"cloud.provider"}, Literal: "on-prem"}),
	"organisation": kind("organisation", req("cloud.provider"), req("$pack.org_id")),
	"account":      kind("account", req("cloud.provider"), req("cloud.account.id")),
	"region":       kind("region", req("cloud.provider"), req("cloud.region")),
	"zone":         kind("zone", req("cloud.provider"), req("cloud.availability_zone")),
	"site":         kind("site", req("site.name")),
	"rack":         kind("rack", req("site.name"), req("rack.name")),
	"cluster":      kind("cluster", req("k8s.cluster.uid", "k8s.cluster.name")),
	"node":         kind("node", req("k8s.cluster.name"), req("k8s.node.name")),
	"namespace":    kind("namespace", req("k8s.cluster.name"), req("k8s.namespace.name")),
	"workload": kind("workload", req("k8s.cluster.name"), req("k8s.namespace.name"),
		req("$k8s.workload_kind"), req("$k8s.workload_name")),
	"pod":       kind("pod", req("k8s.cluster.name"), req("k8s.namespace.name"), req("k8s.pod.name")),
	"container": kind("container", req("k8s.pod.uid", "k8s.pod.name"), req("k8s.container.name", "container.name")),
	"host":      kind("host", req("host.id", "host.name")),
	"process":   kind("process", req("host.name"), req("process.pid"), req("process.executable.name")),
	"service":   kind("service", opt("service.namespace"), req("service.name")),
	"route":     kind("route", opt("service.namespace"), req("service.name"), req("http.route", "span.name")),
	"resource":  kind("resource", req("cloud.provider"), req("cloud.resource_id")),
}

// position returns the index of the position of k that has key as an alternative, or -1.
func (k Kind) position(key string) int {
	for i, p := range k.Positions {
		for _, a := range p.Alts {
			if a == key {
				return i
			}
		}
	}
	return -1
}
