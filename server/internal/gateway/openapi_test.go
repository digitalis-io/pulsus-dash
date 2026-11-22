package gateway

import (
	"os"
	"strings"
	"testing"

	"go.yaml.in/yaml/v3"
)

// unit:permission-declared (T06-023 declaration): every data operation declares query.read and
// the tenant parameter.
func TestPermissionDeclared(t *testing.T) {
	b, err := os.ReadFile("../../../api/openapi.yaml")
	if err != nil {
		t.Fatal(err)
	}
	type param struct {
		Ref      string `yaml:"$ref"`
		Name     string `yaml:"name"`
		In       string `yaml:"in"`
		Required bool   `yaml:"required"`
		Schema   struct {
			Pattern string `yaml:"pattern"`
		} `yaml:"schema"`
	}
	var spec struct {
		Paths map[string]map[string]struct {
			OperationID string  `yaml:"operationId"`
			Permission  string  `yaml:"x-permission"`
			Parameters  []param `yaml:"parameters"`
		} `yaml:"paths"`
		Components struct {
			Parameters map[string]param `yaml:"parameters"`
		} `yaml:"components"`
	}
	if err := yaml.Unmarshal(b, &spec); err != nil {
		t.Fatal(err)
	}
	want := map[string]bool{"postPromqlRange": false, "postPromqlInstant": false, "getPromLabels": false,
		"getPromLabelValues": false, "getPromSeries": false, "getPromMetadata": false, "getDatasourceCheck": false,
		"postLogqlRange": false, "postLogqlVolume": false, "getLogsLabels": false, "getLogsLabelValues": false, "getLogsSeries": false}
	for path, ops := range spec.Paths {
		for method, op := range ops {
			if _, ok := want[op.OperationID]; !ok {
				continue
			}
			want[op.OperationID] = true
			if op.Permission != "query.read" {
				t.Errorf("%s %s: x-permission %q, want query.read", method, path, op.Permission)
			}
			tenant := false
			for _, p := range op.Parameters {
				if name, ok := strings.CutPrefix(p.Ref, "#/components/parameters/"); ok {
					p = spec.Components.Parameters[name]
				}
				if p.Name == "tenant" && p.In == "query" && p.Required && p.Schema.Pattern == "^[a-z0-9-]{1,40}$" {
					tenant = true
				}
			}
			if !tenant {
				t.Errorf("%s %s: no required tenant query parameter with the slug pattern", method, path)
			}
		}
	}
	for id, found := range want {
		if !found {
			t.Errorf("operation %s is not in the spec", id)
		}
	}
}
