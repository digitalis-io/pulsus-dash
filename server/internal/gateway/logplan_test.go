package gateway

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/digitalis-io/pulsus-dash/server/internal/core"
	"github.com/digitalis-io/pulsus-dash/server/internal/keyhash"
	"github.com/digitalis-io/pulsus-dash/server/internal/pulsusdb"
	logplan "github.com/digitalis-io/pulsus-dash/server/internal/pulsusdb/logs"
)

// The route rows of plan #116 A.2 (window logWin: 1 h, 1 200 px, step 5 000).

const (
	reservedR = `source="pulsus-dash"`
	// m1Query is A.1.3 M1: at the placeholder the value is pulsus\x1sdash (an invalid escape), at
	// a two-day step it is pulsus\x2ddash = pulsus-dash.
	m1Query = `{source="pulsus\x${__interval}dash"}`
)

// logPlannedOf is a decoded LogqlPlannedQuery.
type logPlannedOf struct {
	Query    string `json:"query"`
	Expanded string `json:"expanded"`
	Bytes    int    `json:"bytes"`
	StepMs   int64  `json:"step_ms"`
}

// logPlanBody is the members of a LogQL response these tests read.
type logPlanBody struct {
	Planned *logPlannedOf `json:"planned"`
	Error   *struct {
		Code    string         `json:"code"`
		Message string         `json:"message"`
		Hint    map[string]any `json:"hint"`
		Fields  []struct {
			Pointer    string `json:"pointer"`
			MessageKey string `json:"message_key"`
		} `json:"fields"`
		Planned *logPlannedOf `json:"planned"`
	} `json:"error"`
}

func logPlanBodyOf(t *testing.T, rec *httptest.ResponseRecorder) logPlanBody {
	t.Helper()
	var b logPlanBody
	if err := json.Unmarshal(rec.Body.Bytes(), &b); err != nil {
		t.Fatalf("body %.200q: %v", rec.Body.String(), err)
	}
	return b
}

// logBodyVars is logBody with vars.
func logBodyVars(query string, vars map[string]string, extra string) string {
	v, _ := json.Marshal(vars)
	return logBody(query, `,"vars":`+string(v)+extra)
}

// emptyMatrix answers a metric query.
const emptyMatrix = `{"status":"success","data":{"resultType":"matrix","result":[]}}`

// planUpstream records every request and answers a metric query with an empty matrix, anything
// else with an empty streams answer.
func planUpstream(t *testing.T) *logUpstream {
	return newLogUpstream(t, func(w http.ResponseWriter, r *http.Request) {
		q := r.Form.Get("query")
		if strings.HasPrefix(q, "sum") || strings.Contains(q, "count_over_time") {
			writeJSONBody(w, emptyMatrix)
			return
		}
		writeJSONBody(w, emptyStreams)
	})
}

// classifyCase is an entry of logql.json's classify group (plan #116 §3.5).
type classifyCase struct {
	Name string            `json:"name"`
	Text string            `json:"text"`
	Vars map[string]string `json:"vars"`
	Want struct {
		Class string `json:"class"`
	} `json:"want"`
}

func classifyCases(t *testing.T) []classifyCase {
	t.Helper()
	b, err := os.ReadFile("../../../wire/fixtures/plan/logql.json")
	if err != nil {
		t.Fatal(err)
	}
	var f struct {
		Classify []classifyCase `json:"classify"`
	}
	if err := json.Unmarshal(b, &f); err != nil || len(f.Classify) == 0 {
		t.Fatalf("fixture: %v, %d classify cases", err, len(f.Classify))
	}
	return f.Classify
}

// caseID is the leading word of a case name ("L10").
func caseID(name string) string { id, _, _ := strings.Cut(name, " "); return id }

func noPlanned(t *testing.T, what string, b logPlanBody) {
	t.Helper()
	if b.Planned != nil || (b.Error != nil && b.Error.Planned != nil) {
		t.Errorf("%s: a refusal before planning carries planned", what)
	}
}

var logPaths = map[string]string{"range": logRangePath, "volume": logVolumePath}

// itest:logql-planned (A.2 G1–G8 and the Q-rows): the routes plan the raw text with vars and
// write planned.
func TestLogqlPlanned(t *testing.T) {
	up := newLogUpstream(t, func(w http.ResponseWriter, r *http.Request) {
		q := r.Form.Get("query")
		if strings.HasPrefix(q, "sum") {
			writeJSONBody(w, a1Answer(false, "matrix", a1Metric()))
			return
		}
		writeJSONBody(w, emptyStreams)
	})
	h, _ := queryGateway(t, up.URL, pulsusdb.Options{})
	for _, c := range []struct {
		name, path, body string
		upstream         string // the query sent
		prefix           string // the body's first bytes
	}{
		{"G1", logRangePath, logBodyVars(`{app="$a"}`, map[string]string{"a": "x"}, ""), `{app="x"}`,
			`{"kind":"streams","planned":{"query":"{app=\"x\"}","expanded":"{app=\"x\"}","bytes":9,"step_ms":5000},"start":1767225600000`},
		{"G2", logRangePath, logBody(`sum(count_over_time({app="x"}[$__interval]))`, ""), `sum(count_over_time({app="x"}[5s]))`,
			`{"kind":"series","planned":{"query":"sum(count_over_time({app=\"x\"}[5s]))","expanded":"sum(count_over_time({app=\"x\"}[5s]))","bytes":35,"step_ms":5000},"start":`},
		{"G3", logVolumePath, logBodyVars(`{app="$a"}`, map[string]string{"a": "x"}, ""),
			"sum by (level, detected_level) (count_over_time({app=\"x\"}\n| drop __error__ [5s]))",
			`{"planned":{"query":"sum by (level, detected_level) (count_over_time({app=\"x\"}\n| drop __error__ [5s]))","expanded":"{app=\"x\"}","bytes":81,"step_ms":5000},"start":`},
		{"G7", logRangePath, logBody(`{app="x"} |= "$__auto"`, ""), `{app="x"} |= "$__auto"`, `{"kind":"streams","planned":{"query":`},
	} {
		up.reset()
		rec := postJSON(h, c.path, c.body)
		rs := up.requests()
		if rec.Code != 200 || len(rs) != 1 || rs[0].Form.Get("query") != c.upstream {
			t.Errorf("%s: %d %.300s, upstream %d %q", c.name, rec.Code, rec.Body.String(), len(rs), c.upstream)
			continue
		}
		if !strings.HasPrefix(rec.Body.String(), c.prefix) {
			t.Errorf("%s: body %.300s\nwant prefix %s", c.name, rec.Body.String(), c.prefix)
		}
	}

	up.reset()
	e := wantError(t, "G4", postJSON(h, logRangePath, logBody(`{app="$b"}`, "")), 400, "invalid", "/vars/b", "variable.missing")
	if e.Error.Message != "no value for variable $b" {
		t.Errorf("G4: message %q", e.Error.Message)
	}
	wantError(t, "G5", postJSON(h, logRangePath, logBody(`{app="x"}`, `,"rate":true`)), 400, "invalid", "/rate", "field.unknown")
	wantError(t, "G6", postJSON(h, logRangePath, logBody(`{app="x"}`, `,"vars":{"a":1}`)), 400, "invalid", "/vars/a", "field.type")
	if rec := postJSON(h, logRangePath, logBody(`{app="$b"}`, "")); logPlanBodyOf(t, rec).Error == nil {
		t.Error("G4: no error")
	} else {
		noPlanned(t, "G4", logPlanBodyOf(t, rec))
	}
	if n := len(up.requests()); n != 0 {
		t.Errorf("G4–G6: %d upstream requests", n)
	}

	// G8: an upstream 503 gives the gateway's unavailable envelope (502, unchanged mapping) with
	// the plan.
	u503 := newLogUpstream(t, func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		w.WriteHeader(http.StatusServiceUnavailable)
		_, _ = w.Write([]byte("overloaded"))
	})
	h503, _ := queryGateway(t, u503.URL, pulsusdb.Options{})
	rec := postJSON(h503, logRangePath, logBodyVars(`{app="$a"}`, map[string]string{"a": "x"}, ""))
	wantError(t, "G8", rec, 502, "unavailable", "-", "")
	if b := logPlanBodyOf(t, rec); b.Error == nil || b.Error.Planned == nil || b.Error.Planned.Query != `{app="x"}` {
		t.Errorf("G8: %d %.300s", rec.Code, rec.Body.String())
	}

	// The Q-rows (A.1.4): values in strings, through the range route.
	for _, c := range []struct {
		name, query, value, sent string
	}{
		{"Q1", `{app="$a"}`, "x\ny", `{app="x\ny"}`},
		{"Q2", `{app="$a"}`, "x\ty", `{app="x\ty"}`},
		{"Q3", `{app="$a"}`, "x\x01y", `{app="x\x01y"}`},
		{"Q4", `{app="$a"}`, "\x7f", `{app="\x7f"}`},
		{"Q5", `{app="$a"}`, "ü€😀", `{app="ü€😀"}`},
		{"Q6", "{app=`$a`}", "x`y", ""},
		{"Q7", `{app="$a"}`, "x`y", "{app=\"x`y\"}"},
		{"Q8", `{app="$a"}`, " ", "{app=\" \"}"},
		{"Q9", "{app=`$a`}", "x\ry", ""},
		{"Q10", `{app="x"} # $a`, "z\n{source=\"pulsus-dash\"}", "hash"},
		{"Q11", `$a`, "{app=\"x\"}\n|= \"y\"", "{app=\"x\"}\n|= \"y\""},
	} {
		up.reset()
		rec := postJSON(h, logRangePath, logBodyVars(c.query, map[string]string{"a": c.value}, ""))
		rs := up.requests()
		if c.sent == "hash" {
			// Q10 (plan #121 §3.3): the value is top-level text after a '#', refused by row 9b.
			wantHashRefusal(t, c.name, rec, 10)
			if len(rs) != 0 {
				t.Errorf("%s: %d upstream requests", c.name, len(rs))
			}
			continue
		}
		if c.sent == "" {
			e := wantError(t, c.name, rec, 400, "invalid", "/vars/a", "variable.unrepresentable")
			if e.Error.Message != "the value of variable $a cannot be written where it is referenced" {
				t.Errorf("%s: message %q", c.name, e.Error.Message)
			}
			noPlanned(t, c.name, logPlanBodyOf(t, rec))
			if len(rs) != 0 {
				t.Errorf("%s: %d upstream requests", c.name, len(rs))
			}
			continue
		}
		if rec.Code != 200 || len(rs) != 1 || rs[0].Form.Get("query") != c.sent {
			got := ""
			if len(rs) > 0 {
				got = rs[0].Form.Get("query")
			}
			t.Errorf("%s: %d %.200s, %d upstream requests, sent %q, want %q", c.name, rec.Code, rec.Body.String(), len(rs), got, c.sent)
		}
	}
}

// itest:logql-virtual-refused (A.2 R1–R4): every reserved selector the reader finds, and the
// ones only the byte guard finds, is refused on both routes before tenant resolution and any
// upstream request; the near misses reach PulsusDB.
func TestLogqlVirtualRefused(t *testing.T) {
	cases := classifyCases(t)
	up := planUpstream(t)
	h, _ := queryGateway(t, up.URL, pulsusdb.Options{})
	refuse := func(what, path string, c classifyCase) {
		up.reset()
		rec := postJSON(h, path, logBodyVars(c.Text, c.Vars, ""))
		e := wantError(t, what, rec, 400, "virtual_unsupported", "/query", "query.reserved")
		if e.Error.Hint["reserved"] != reservedR {
			t.Errorf("%s: hint %v", what, e.Error.Hint)
		}
		noPlanned(t, what, logPlanBodyOf(t, rec))
		if n := len(up.requests()); n != 0 {
			t.Errorf("%s: %d upstream requests, want 0", what, n)
		}
	}
	// hashFirst (plan #121 §4.3): a text with a top-level '#' is refused by row 9b as
	// query.invalid before the reserved-selector check, so it is never sent either.
	hashFirst := map[string]bool{"L12": true, "L21": true}
	guardOnly := map[string]bool{"L10": true, "L22": true}
	passes := map[string]bool{"L3": true, "L9": true, "L11": true, "L14": true, "L18": true}
	var nR1, nR2, nR3, nHash int
	for _, c := range cases {
		id := caseID(c.Name)
		switch {
		case hashFirst[id]:
			nHash++
			for kind, path := range logPaths {
				up.reset()
				what := "hash " + kind + " " + c.Name
				rec := postJSON(h, path, logBodyVars(c.Text, c.Vars, ""))
				wantError(t, what, rec, 400, "invalid", "/query", "query.invalid")
				noPlanned(t, what, logPlanBodyOf(t, rec))
				if n := len(up.requests()); n != 0 {
					t.Errorf("%s: %d upstream requests, want 0", what, n)
				}
			}
		case c.Want.Class == "virtual" || c.Want.Class == "mixed":
			nR1++
			for kind, path := range logPaths {
				refuse("R1 "+kind+" "+c.Name, path, c)
			}
		case guardOnly[id]:
			nR2++
			for kind, path := range logPaths {
				refuse("R2 "+kind+" "+c.Name, path, c)
			}
		case passes[id]:
			nR3++
			up.reset()
			rec := postJSON(h, logRangePath, logBodyVars(c.Text, c.Vars, ""))
			if rs := up.requests(); rec.Code != 200 || len(rs) != 1 || rs[0].Form.Get("query") != c.Text {
				t.Errorf("R3 %s: %d %.200s after %d upstream requests", c.Name, rec.Code, rec.Body.String(), len(rs))
			}
		}
	}
	if nR1 != 13 || nR2 != 2 || nR3 != 5 || nHash != 2 {
		t.Errorf("rows R1 %d, R2 %d, R3 %d, hash %d; want 13, 2, 5, 2", nR1, nR2, nR3, nHash)
	}

	// R4: refused before tenant resolution.
	var calls atomic.Int32
	ho, ct, _ := orderGateway(func(context.Context) (core.BootstrapView, error) {
		calls.Add(1)
		return core.BootstrapView{}, nil
	})
	for _, c := range cases {
		if id := caseID(c.Name); id != "L1" && id != "L6" {
			continue
		}
		for kind, path := range logPaths {
			wantError(t, "R4 "+kind+" "+c.Name, postJSON(ho, path, logBodyVars(c.Text, c.Vars, "")), 400, "virtual_unsupported", "/query", "query.reserved")
		}
	}
	if calls.Load() != 0 || ct.n.Load() != 0 {
		t.Errorf("R4: %d bootstrap calls, %d upstream requests; want 0, 0", calls.Load(), ct.n.Load())
	}
}

// itest:plan-authority (LogQL, A.2 A1–A3, T06-029): the text sent is the body's planned.query.
func TestLogqlPlanAuthority(t *testing.T) {
	up := planUpstream(t)
	h, _ := queryGateway(t, up.URL, pulsusdb.Options{})
	for _, c := range []struct{ name, path, body string }{
		{"A1 G1", logRangePath, logBodyVars(`{app="$a"}`, map[string]string{"a": "x"}, "")},
		{"A1 G2", logRangePath, logBody(`sum(count_over_time({app="x"}[$__interval]))`, "")},
		{"A1 G3", logVolumePath, logBodyVars(`{app="$a"}`, map[string]string{"a": "x"}, "")},
		{"A3", logRangePath, logBody(`{app="x"}`, "")},
	} {
		up.reset()
		rec := postJSON(h, c.path, c.body)
		b, rs := logPlanBodyOf(t, rec), up.requests()
		if rec.Code != 200 || b.Planned == nil || len(rs) != 1 || rs[0].Form.Get("query") != b.Planned.Query {
			t.Errorf("%s: %d %.200s, %d upstream requests", c.name, rec.Code, rec.Body.String(), len(rs))
		}
		if c.name == "A3" && (len(rs) != 1 || rs[0].Form.Get("query") != `{app="x"}`) {
			t.Errorf("A3: the raw text was not sent byte for byte")
		}
	}
	// A2: a volume planned.query sent back as the raw query is wrapped again.
	const g3 = "sum by (level, detected_level) (count_over_time({app=\"x\"}\n| drop __error__ [5s]))"
	up.reset()
	rec := postJSON(h, logVolumePath, logBody(g3, ""))
	b, rs := logPlanBodyOf(t, rec), up.requests()
	want := "sum by (level, detected_level) (count_over_time(" + g3 + "\n| drop __error__ [5s]))"
	if rec.Code != 200 || len(rs) != 1 || rs[0].Form.Get("query") != want || len(want) != 153 || b.Planned == nil || b.Planned.Expanded != g3 {
		t.Errorf("A2: %d %.300s, %d upstream requests", rec.Code, rec.Body.String(), len(rs))
	}
}

// itest:logql-plan-sizes (A.2 Z1–Z4, T09-015): 128 KB raw, 64 KiB planned with the template.
func TestLogqlPlanSizes(t *testing.T) {
	up := planUpstream(t)
	h, _ := queryGateway(t, up.URL, pulsusdb.Options{})
	n9 := `{app="x"} |= "` + strings.Repeat("a", 65_485) + `"`

	rec := postJSON(h, logRangePath, logBody(strings.Repeat("a", 131_073), ""))
	e := wantError(t, "Z1", rec, 400, "invalid", "/query", "field.range")
	if e.Error.Message != "query must be 1 to 131072 bytes" || len(up.requests()) != 0 {
		t.Errorf("Z1: %q after %d upstream requests", e.Error.Message, len(up.requests()))
	}

	if rec := postJSON(h, logRangePath, logBody(n9, "")); rec.Code != 200 || len(up.requests()) != 1 {
		t.Errorf("Z2 range: %d %.200s, %d upstream requests", rec.Code, rec.Body.String(), len(up.requests()))
	}
	up.reset()
	rec = postJSON(h, logVolumePath, logBody(n9, ""))
	wantError(t, "Z2 volume", rec, 413, "invalid", "/query", "query.sent_too_large")
	if b := logPlanBodyOf(t, rec); b.Error == nil || b.Error.Planned == nil || b.Error.Planned.Bytes != 65_572 || len(up.requests()) != 0 {
		t.Errorf("Z2 volume: %.200s, %d upstream requests", rec.Body.String(), len(up.requests()))
	}

	rec = postJSON(h, logRangePath, logBodyVars(strings.Repeat("$r", 600), map[string]string{"r": strings.Repeat("a", 4_096)}, ""))
	e = wantError(t, "Z3", rec, 413, "invalid", "/query", "query.too_large_to_plan")
	if e.Error.Hint["reason"] != "processing_cap" || len(up.requests()) != 0 {
		t.Errorf("Z3: hint %v, %d upstream requests", e.Error.Hint, len(up.requests()))
	}
	noPlanned(t, "Z3", logPlanBodyOf(t, rec))

	rec = postJSON(h, logRangePath, logBody(strings.Repeat("a", 131_072), ""))
	wantError(t, "Z4", rec, 413, "invalid", "/query", "query.sent_too_large")
	if b := logPlanBodyOf(t, rec); b.Error == nil || b.Error.Planned == nil || b.Error.Planned.Bytes != 131_072 || len(up.requests()) != 0 {
		t.Errorf("Z4: %.200s, %d upstream requests", rec.Body.String(), len(up.requests()))
	}
}

// itest:logql-error-position (A.2 E1–E3, T09-009): PulsusDB's position is mapped to the raw text,
// and none inside the volume template.
func TestLogqlErrorPosition(t *testing.T) {
	var msg atomic.Value
	up := newLogUpstream(t, func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		w.WriteHeader(http.StatusBadRequest)
		_, _ = io.WriteString(w, msg.Load().(string))
	})
	h, _ := queryGateway(t, up.URL, pulsusdb.Options{})
	for _, c := range []struct {
		name, path, body, upstream string
		pos                        int // -1 = none
		message, planned           string
	}{
		{"E1", logRangePath, logBodyVars(`{app="$a"}`, map[string]string{"a": "xyz"}, ""), "parse error at byte 8", 6, "parse error at byte 6", `{app="xyz"}`},
		{"E2", logVolumePath, logBody(`{app="x"`, ""), "unexpected '[' at byte 57: x", -1, "unexpected '[' at byte 57: x",
			"sum by (level, detected_level) (count_over_time({app=\"x\"\n| drop __error__ [5s]))"},
		{"E2a", logVolumePath, logBody(`{app="x"`, ""), "unexpected '[' at byte 50: x", 2, "unexpected '[' at byte 2: x", ""},
		{"E3", logVolumePath, logBody(`{app="x"`, ""), "unexpected '[' at byte 47: x", -1, "unexpected '[' at byte 47: x", ""},
	} {
		msg.Store(c.upstream)
		rec := postJSON(h, c.path, c.body)
		e := wantError(t, c.name, rec, 400, "invalid", "/query", "query.invalid")
		pos, has := e.Error.Hint["position"].(map[string]any)
		switch {
		case c.pos < 0 && has:
			t.Errorf("%s: position %v, want none", c.name, pos)
		case c.pos >= 0 && (!has || pos["offset"] != float64(c.pos)):
			t.Errorf("%s: position %v, want %d", c.name, e.Error.Hint["position"], c.pos)
		}
		if e.Error.Message != c.message {
			t.Errorf("%s: message %q, want %q", c.name, e.Error.Message, c.message)
		}
		if b := logPlanBodyOf(t, rec); b.Error == nil || b.Error.Planned == nil || (c.planned != "" && b.Error.Planned.Query != c.planned) {
			t.Errorf("%s: planned %.300s", c.name, rec.Body.String())
		}
	}
}

// itest:logql-virtual-refused, the final guard (A.2 F1–F2, plan #116 §3.2): the planned text's
// classification is authoritative.
func TestLogqlFinalGuard(t *testing.T) {
	up := planUpstream(t)
	logs := &syncBuffer{}
	q := &dataRoutes{d: Deps{Logger: slog.New(slog.NewJSONHandler(logs, nil))}}
	// F1: no ladder step is two days, so the route's steps 3–6 are called directly.
	_, e := q.logPlanFor(context.Background(), logplan.Inputs{Query: m1Query, Vars: map[string]string{}, Kind: logplan.KindRange, StepMs: 172_800_000})
	if e == nil {
		t.Fatal("F1: planned, want the step 6 refusal")
	}
	rec := httptest.NewRecorder()
	writeReqError(rec, e)
	ee := wantError(t, "F1", rec, 400, "virtual_unsupported", "/query", "query.reserved")
	if b := logPlanBodyOf(t, rec); ee.Error.Hint["reserved"] != reservedR || b.Error == nil || b.Error.Planned == nil ||
		b.Error.Planned.Query != `{source="pulsus\x2ddash"}` {
		t.Errorf("F1: %s", rec.Body.String())
	}
	if n := len(up.requests()); n != 0 {
		t.Errorf("F1: %d upstream requests", n)
	}

	// F2: at one day the value is pulsus 0x1D dash, which reads PulsusDB.
	h, _ := queryGateway(t, up.URL, pulsusdb.Options{})
	rec = postJSON(h, logRangePath, `{"query":`+jsonString(m1Query)+`,"from":0,"to":864000000,"width_px":10}`)
	if rs := up.requests(); rec.Code != 200 || len(rs) != 1 || rs[0].Form.Get("query") != `{source="pulsus\x1ddash"}` {
		t.Errorf("F2: %d %.300s after %d upstream requests", rec.Code, rec.Body.String(), len(rs))
	}
}

// The cursor binds the planned text (A.2 C1–C2, plan #116 §4.4 step 7, Q6).
func TestLogqlCursorBindsPlanned(t *testing.T) {
	up := a1Upstream(t, false)
	h, _ := queryGateway(t, up.URL, pulsusdb.Options{})
	vars := func(v string) map[string]string { return map[string]string{"a": v} }
	rec := postJSON(h, logRangePath, logBodyVars(`{app="$a"}`, vars("x"), `,"limit":4`))
	p := decodePage(t, rec.Body.Bytes())
	if rec.Code != 200 || p.Cursor == nil {
		t.Fatalf("C1 page 1: %d %.300s", rec.Code, rec.Body.String())
	}
	c, err := decodeCursor(*p.Cursor)
	if err != nil || c.QueryHash != keyhash.Text(`{app="x"}`) {
		t.Errorf("C1: cursor %+v %v, want the hash of the planned text", c, err)
	}
	if rec := postJSON(h, logRangePath, logBodyVars(`{app="$a"}`, vars("x"), `,"limit":4,"cursor":"`+*p.Cursor+`"`)); rec.Code != 200 {
		t.Errorf("C1 page 2: %d %.300s", rec.Code, rec.Body.String())
	}
	rec = postJSON(h, logRangePath, logBodyVars(`{app="$a"}`, vars("y"), `,"limit":4,"cursor":"`+*p.Cursor+`"`))
	wantError(t, "C2", rec, 400, "invalid", "/cursor", "cursor.mismatch")
	if b := logPlanBodyOf(t, rec); b.Error == nil || b.Error.Planned == nil || b.Error.Planned.Query != `{app="y"}` {
		t.Errorf("C2: %.300s", rec.Body.String())
	}
}

// wantHashRefusal checks a row-9b response (plan #121 §3.2): 400 invalid, /query query.invalid,
// the message and hint.position.offset at pos, and no planned.
func wantHashRefusal(t *testing.T, what string, rec *httptest.ResponseRecorder, pos int) {
	t.Helper()
	e := wantError(t, what, rec, 400, "invalid", "/query", "query.invalid")
	if want := "unexpected '#' at byte " + strconv.Itoa(pos) + ": LogQL has no comments"; e.Error.Message != want {
		t.Errorf("%s: message %q, want %q", what, e.Error.Message, want)
	}
	if p, ok := e.Error.Hint["position"].(map[string]any); !ok || p["offset"] != float64(pos) || len(e.Error.Hint) != 1 {
		t.Errorf("%s: hint %v, want {position: {offset: %d}}", what, e.Error.Hint, pos)
	}
	noPlanned(t, what, logPlanBodyOf(t, rec))
}

// itest:logql-hash-refused (plan #121 §5.1, T07-020, T06-029): a '#' outside strings, raw or
// from a value, is refused with its mapped position on both routes before any upstream request,
// a spaced or escaped reserved selector after it included; a '#' inside a string is planned and
// sent as is.
func TestLogqlHashRefused(t *testing.T) {
	up := planUpstream(t)
	h, _ := queryGateway(t, up.URL, pulsusdb.Options{})
	h1 := "# x\r{source = \"pulsus-dash\"}"
	h2 := map[string]string{"q": "{app=\"x\"} # c\r{ source = \"pulsus-dash\" }"}
	refused := []struct {
		name, query string
		vars        map[string]string
		pos         int
	}{
		{"H1", h1, nil, 0},
		{"H2", "$q", h2, 0},
		{"H3", "# x\r{source=\"pulsus\\x2ddash\"}", nil, 0},
		{"H4", `{app="$a"} # c`, map[string]string{"a": "xyz"}, 11},
		{"H9", "{app=\"x\n# c", nil, 8},
		{"H10", "$a", map[string]string{"a": "#"}, 0},
		{"H12", `{app="x"} # y`, nil, 10},
	}
	for _, c := range refused {
		for _, kind := range []string{"range", "volume"} {
			up.reset()
			what := c.name + " " + kind
			vars := c.vars
			if vars == nil {
				vars = map[string]string{}
			}
			rec := postJSON(h, logPaths[kind], logBodyVars(c.query, vars, ""))
			if n := len(up.requests()); n != 0 {
				t.Errorf("%s: %d upstream requests, want 0", what, n)
			}
			wantHashRefusal(t, what, rec, c.pos)
		}
	}
	for _, c := range []struct {
		name, query string
		vars        map[string]string
		sent        string
	}{
		{"H5", `{app="x"} |= "#"`, nil, `{app="x"} |= "#"`},
		{"H6", "{app=\"x\"} |= `#`", nil, "{app=\"x\"} |= `#`"},
		{"H7", `{app="$a"}`, map[string]string{"a": "#"}, `{app="#"}`},
		{"H8", `{app="x\"#"}`, nil, `{app="x\"#"}`},
	} {
		up.reset()
		vars := c.vars
		if vars == nil {
			vars = map[string]string{}
		}
		rec := postJSON(h, logRangePath, logBodyVars(c.query, vars, ""))
		b, rs := logPlanBodyOf(t, rec), up.requests()
		if rec.Code != 200 || len(rs) != 1 || rs[0].Form.Get("query") != c.sent || b.Planned == nil || b.Planned.Query != c.sent {
			t.Errorf("%s: %d %.200s, %d upstream requests, want 1 sending %q", c.name, rec.Code, rec.Body.String(), len(rs), c.sent)
		}
	}

	// Refused before tenant resolution: no bootstrap call and no upstream request.
	var calls atomic.Int32
	ho, ct, _ := orderGateway(func(context.Context) (core.BootstrapView, error) {
		calls.Add(1)
		return core.BootstrapView{}, nil
	})
	for _, c := range refused[:2] {
		for _, kind := range []string{"range", "volume"} {
			vars := c.vars
			if vars == nil {
				vars = map[string]string{}
			}
			wantHashRefusal(t, "order "+c.name+" "+kind, postJSON(ho, logPaths[kind], logBodyVars(c.query, vars, "")), c.pos)
		}
	}
	if calls.Load() != 0 || ct.n.Load() != 0 {
		t.Errorf("order: %d bootstrap calls, %d upstream requests; want 0, 0", calls.Load(), ct.n.Load())
	}
}
