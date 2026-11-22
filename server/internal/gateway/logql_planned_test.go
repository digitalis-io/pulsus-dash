package gateway

import (
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"

	"github.com/digitalis-io/pulsus-dash/server/internal/pulsusdb"
	"github.com/digitalis-io/pulsus-dash/server/internal/pulsusfake/fakeharness"
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
