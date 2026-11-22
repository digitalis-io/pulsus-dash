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

// T06-029 (plan #116): the LogQL range and volume bodies, success and error, carry planned:
// after kind on the range route, first on the volume route.
func TestLogqlBodiesCarryPlanned(t *testing.T) {
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
		prefix           string
	}{
		{"metric", logRangePath, logBody(`sum by (level) (count_over_time({app="x"}[1m]))`, ""), 200, `{"kind":"series","planned":{`},
		{"streams", logRangePath, logBody(`{app="x"}`, ""), 200, `{"kind":"streams","planned":{"query":`},
		{"volume", logVolumePath, logBody(`{app="x"}`, ""), 200, `{"planned":{"query":"sum by (level`},
		{"upstream error", logRangePath, logBody(`{app="fail_upstream"}`, ""), 400, `{"error":`},
	} {
		rec := postJSON(h, c.path, c.body)
		var top map[string]json.RawMessage
		if err := json.Unmarshal(rec.Body.Bytes(), &top); err != nil || rec.Code != c.status {
			t.Errorf("%s: %d %v %.300s", c.name, rec.Code, err, rec.Body.String())
			continue
		}
		if !strings.HasPrefix(rec.Body.String(), c.prefix) {
			t.Errorf("%s: body %.120s, want prefix %s", c.name, rec.Body.String(), c.prefix)
		}
		if c.status == 400 {
			var e struct {
				Error map[string]json.RawMessage `json:"error"`
			}
			if err := json.Unmarshal(rec.Body.Bytes(), &e); err != nil {
				t.Fatal(err)
			}
			if _, ok := e.Error["planned"]; !ok {
				t.Errorf("%s: the LogQL error has no planned member: %s", c.name, rec.Body.String())
			}
		} else if _, ok := top["planned"]; !ok {
			t.Errorf("%s: the LogQL body has no planned member: %.300s", c.name, rec.Body.String())
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

// The volume operation's 200 schema is LogqlVolumeResponse, planned first (plan #116 §3.3), the
// planned-free RangeFrameResponse is gone, and a volume body validates against it: every required
// member present, none outside its properties (additionalProperties false).
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
	if ref != "#/components/schemas/LogqlVolumeResponse" {
		t.Fatalf("postLogqlVolume 200 schema %q, want LogqlVolumeResponse", ref)
	}
	if _, ok := doc.Components.Schemas["RangeFrameResponse"]; ok {
		t.Error("RangeFrameResponse is still in components.schemas")
	}
	s := doc.Components.Schemas[strings.TrimPrefix(ref, "#/components/schemas/")]
	if !slices.Equal(s.Required, []string{"planned", "start", "end", "step", "frames", "completeness"}) {
		t.Errorf("LogqlVolumeResponse required = %v", s.Required)
	}
	if _, ok := s.Properties["planned"]; !ok || s.AdditionalProperties.Value != "false" {
		t.Errorf("LogqlVolumeResponse must have planned and additionalProperties false")
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
			t.Errorf("volume body member %q is not in LogqlVolumeResponse", k)
		}
	}
}
