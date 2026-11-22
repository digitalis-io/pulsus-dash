package gateway

import (
	"encoding/json"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"github.com/digitalis-io/pulsus-dash/server/internal/pulsusdb"
	"github.com/digitalis-io/pulsus-dash/server/internal/pulsusfake/fakeharness"
	"go.yaml.in/yaml/v3"
)

// T06-029 note (#65 Part B): `planned` is PromQL-only until logs.Plan lands (#116). The LogQL
// range and volume bodies, success and error, carry no planned member.
func TestLogqlBodiesCarryNoPlanned(t *testing.T) {
	up := newLogUpstream(t, func(w http.ResponseWriter, r *http.Request) {
		q := r.Form.Get("query")
		switch {
		case strings.Contains(q, "fail_upstream"):
			w.Header().Set("Content-Type", "text/plain; charset=utf-8")
			w.WriteHeader(http.StatusBadRequest)
			_, _ = io.WriteString(w, "parse error at byte 3")
		case strings.HasPrefix(q, "sum by (level"):
			writeJSONBody(w, a1Answer(false, "matrix", a1Metric()))
		default:
			writeJSONBody(w, emptyStreams)
		}
	})
	h, _ := queryGateway(t, up.URL, pulsusdb.Options{})
	for _, c := range []struct {
		name, path, body string
		status           int
	}{
		{"metric", logRangePath, logBody(`sum by (level) (count_over_time({app="x"}[1m]))`, ""), 200},
		{"streams", logRangePath, logBody(`{app="x"}`, ""), 200},
		{"volume", logVolumePath, logBody(`{app="x"}`, ""), 200},
		{"upstream error", logRangePath, logBody(`{app="fail_upstream"}`, ""), 400},
	} {
		rec := postJSON(h, c.path, c.body)
		var top map[string]json.RawMessage
		if err := json.Unmarshal(rec.Body.Bytes(), &top); err != nil || rec.Code != c.status {
			t.Errorf("%s: %d %v %.300s", c.name, rec.Code, err, rec.Body.String())
			continue
		}
		if _, ok := top["planned"]; ok {
			t.Errorf("%s: the LogQL body has a planned member: %.300s", c.name, rec.Body.String())
		}
		if c.status == 400 {
			var e struct {
				Error map[string]json.RawMessage `json:"error"`
			}
			if err := json.Unmarshal(rec.Body.Bytes(), &e); err != nil {
				t.Fatal(err)
			}
			if _, ok := e.Error["planned"]; ok {
				t.Errorf("%s: the LogQL error has a planned member: %s", c.name, rec.Body.String())
			}
		}
	}
}

// The PromQL range route is unchanged by the LogQL kind: its body starts with planned and
// carries no kind member.
func TestPromRangeKeepsPlanned(t *testing.T) {
	_, url := fakeharness.Start(t)
	h, _ := queryGateway(t, url, pulsusdb.Options{})
	rec := postJSON(h, rangePath, counterReq)
	if rec.Code != 200 || !strings.HasPrefix(rec.Body.String(), `{"planned":{"query":`) {
		t.Fatalf("%d %.200s", rec.Code, rec.Body.String())
	}
	var top map[string]json.RawMessage
	if err := json.Unmarshal(rec.Body.Bytes(), &top); err != nil {
		t.Fatal(err)
	}
	if _, ok := top["kind"]; ok {
		t.Errorf("the PromQL body has a kind member")
	}
}

// The volume operation's 200 schema is the planned-free range frame, and a volume body validates
// against it: every required member present, none outside its properties (additionalProperties
// false), and no planned (T06-029 note, #116).
func TestLogqlVolumeMatchesSpec(t *testing.T) {
	b, err := os.ReadFile(filepath.Join("..", "..", "..", "api", "openapi.yaml"))
	if err != nil {
		t.Fatal(err)
	}
	type schema struct {
		Ref                  string                    `yaml:"$ref"`
		Required             []string                  `yaml:"required"`
		Properties           map[string]map[string]any `yaml:"properties"`
		AdditionalProperties yaml.Node                 `yaml:"additionalProperties"`
	}
	var doc struct {
		Paths map[string]map[string]struct {
			OperationID string `yaml:"operationId"`
			Responses   map[string]struct {
				Content map[string]struct {
					Schema schema `yaml:"schema"`
				} `yaml:"content"`
			} `yaml:"responses"`
		} `yaml:"paths"`
		Components struct {
			Schemas map[string]schema `yaml:"schemas"`
		} `yaml:"components"`
	}
	if err := yaml.Unmarshal(b, &doc); err != nil {
		t.Fatal(err)
	}
	op, ok := doc.Paths["/api/dash/v1/query/logql/volume"]["post"]
	if !ok || op.OperationID != "postLogqlVolume" {
		t.Fatal("no postLogqlVolume operation")
	}
	ref := op.Responses["200"].Content["application/json"].Schema.Ref
	if ref != "#/components/schemas/RangeFrameResponse" {
		t.Fatalf("postLogqlVolume 200 schema %q, want the planned-free RangeFrameResponse", ref)
	}
	s := doc.Components.Schemas[strings.TrimPrefix(ref, "#/components/schemas/")]
	if !slices.Equal(s.Required, []string{"start", "end", "step", "frames", "completeness"}) {
		t.Errorf("RangeFrameResponse required = %v", s.Required)
	}
	if _, ok := s.Properties["planned"]; ok || s.AdditionalProperties.Value != "false" {
		t.Errorf("RangeFrameResponse must have no planned and additionalProperties false")
	}

	up := newLogUpstream(t, func(w http.ResponseWriter, r *http.Request) {
		writeJSONBody(w, a1Answer(false, "matrix", a1Metric()))
	})
	h, _ := queryGateway(t, up.URL, pulsusdb.Options{})
	rec := postJSON(h, logVolumePath, logBody(`{app="x"}`, ""))
	var top map[string]json.RawMessage
	if err := json.Unmarshal(rec.Body.Bytes(), &top); err != nil || rec.Code != 200 {
		t.Fatalf("volume: %d %v %.300s", rec.Code, err, rec.Body.String())
	}
	for _, k := range s.Required {
		if _, ok := top[k]; !ok {
			t.Errorf("volume body lacks required %q", k)
		}
	}
	for k := range top {
		if _, ok := s.Properties[k]; !ok {
			t.Errorf("volume body member %q is not in RangeFrameResponse", k)
		}
	}
}
