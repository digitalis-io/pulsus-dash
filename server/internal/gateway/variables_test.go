package gateway

import (
	"encoding/json"
	"net/http"
	"net/url"
	"reflect"
	"strings"
	"testing"

	"github.com/digitalis-io/pulsus-dash/server/internal/core"
	"github.com/digitalis-io/pulsus-dash/server/internal/pulsusdb"
)

const variablesPath = "/api/dash/v1/variables/values?tenant=demo"

// variablesUpstream answers every label values call with the values a, b and c.
func variablesUpstream(t *testing.T) *logUpstream {
	return newLogUpstream(t, func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, "/values") {
			writeJSONBody(w, `{"status":"success","data":["a","b","c"]}`)
			return
		}
		w.WriteHeader(http.StatusNotFound)
	})
}

// valuesBody is a VariableValuesRequest.
func valuesRequest(lang, query string, extra string) string {
	q, _ := json.Marshal(query)
	return `{"lang":"` + lang + `","query":` + string(q) + `,"from":1000,"to":2000` + extra + `}`
}

type variableValues struct {
	Planned *struct {
		Label string  `json:"label"`
		Match *string `json:"match"`
	} `json:"planned"`
	Values       []string       `json:"values"`
	Completeness map[string]any `json:"completeness"`
}

func variableValuesOf(t *testing.T, b []byte) variableValues {
	t.Helper()
	var v variableValues
	dec := json.NewDecoder(strings.NewReader(string(b)))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&v); err != nil {
		t.Fatalf("body %.300s: %v", b, err)
	}
	return v
}

// wantCall checks the one upstream request: its path and its exact form.
func wantCall(t *testing.T, what string, up *logUpstream, path string, form url.Values) {
	t.Helper()
	rs := up.requests()
	if len(rs) != 1 {
		t.Errorf("%s: %d upstream requests, want 1", what, len(rs))
		return
	}
	if rs[0].Path != path || !reflect.DeepEqual(rs[0].Form, form) {
		t.Errorf("%s: upstream %s %v, want %s %v", what, rs[0].Path, rs[0].Form, path, form)
	}
}

// itest:variable-values (SRF-017, T06-029, plan #289 §3.5, §5; the times as the label values
// calls send them: PromQL seconds floored and raised to the minute, LogQL 19-digit nanoseconds):
// the value route plans
// label_values with the variable rules and calls the label values methods with exactly these
// parameters; a refusal makes no upstream call.
func TestVariableValues(t *testing.T) {
	up := variablesUpstream(t)
	h, _ := queryGateway(t, up.URL, pulsusdb.Options{})
	const sel = `ClickHouseAsyncMetrics_Uptime{job="clickhouse"}`

	// PromQL, the ClickHouse query: start floored and end raised to the minute, as the label
	// values route sends them.
	rec := postJSON(h, variablesPath, valuesRequest("promql", "label_values("+sel+", instance)", `,"limit":50`))
	v := variableValuesOf(t, rec.Body.Bytes())
	if rec.Code != 200 || v.Planned == nil || v.Planned.Label != "instance" || v.Planned.Match == nil || *v.Planned.Match != sel ||
		!reflect.DeepEqual(v.Values, []string{"a", "b", "c"}) || v.Completeness == nil || v.Completeness["truncated"] != false {
		t.Errorf("ClickHouse: %d %s", rec.Code, rec.Body.String())
	}
	wantCall(t, "ClickHouse", up, "/api/v1/label/instance/values", url.Values{"match[]": {sel}, "start": {"0"}, "end": {"60"}, "limit": {"50"}})

	up.reset()
	rec = postJSON(h, variablesPath, valuesRequest("promql", "label_values(instance)", ""))
	if v := variableValuesOf(t, rec.Body.Bytes()); rec.Code != 200 || v.Planned == nil || v.Planned.Match != nil || v.Planned.Label != "instance" ||
		!strings.Contains(rec.Body.String(), `"match":null`) {
		t.Errorf("no selector: %d %s", rec.Code, rec.Body.String())
	}
	wantCall(t, "no selector", up, "/api/v1/label/instance/values", url.Values{"start": {"0"}, "end": {"60"}, "limit": {"1000"}})

	up.reset()
	rec = postJSON(h, variablesPath, valuesRequest("logql", `label_values({app="$app"}, pod)`, `,"vars":{"app":{"values":["api"]}},"limit":2`))
	v = variableValuesOf(t, rec.Body.Bytes())
	if rec.Code != 200 || v.Planned == nil || v.Planned.Match == nil || *v.Planned.Match != `{app="api"}` ||
		!reflect.DeepEqual(v.Values, []string{"a", "b"}) || v.Completeness == nil || v.Completeness["truncated"] != true {
		t.Errorf("LogQL: %d %s", rec.Code, rec.Body.String())
	}
	wantCall(t, "LogQL", up, "/api/logs/v1/label/pod/values", url.Values{"query": {`{app="api"}`}, "start": {"0000000001000000000"}, "end": {"0000000002000000000"}})

	up.reset()
	rec = postJSON(h, variablesPath, valuesRequest("logql", "label_values(pod)", ""))
	if v := variableValuesOf(t, rec.Body.Bytes()); rec.Code != 200 || v.Planned == nil || v.Planned.Match != nil {
		t.Errorf("LogQL no selector: %d %s", rec.Code, rec.Body.String())
	}
	wantCall(t, "LogQL no selector", up, "/api/logs/v1/label/pod/values", url.Values{"start": {"0000000001000000000"}, "end": {"0000000002000000000"}})

	up.reset()
	rec = postJSON(h, variablesPath, valuesRequest("promql", `label_values(up{instance=~"$node"}, job)`, `,"vars":{"node":{"values":["a","b"]}}`))
	if v := variableValuesOf(t, rec.Body.Bytes()); rec.Code != 200 || v.Planned == nil || v.Planned.Match == nil || *v.Planned.Match != `up{instance=~"(?-i:(?:a|b))"}` {
		t.Errorf("chained: %d %s", rec.Code, rec.Body.String())
	}
	wantCall(t, "chained", up, "/api/v1/label/job/values", url.Values{"match[]": {`up{instance=~"(?-i:(?:a|b))"}`}, "start": {"0"}, "end": {"60"}, "limit": {"1000"}})

	// Chained H01–H08: the hostile value keeps the selector's shape, or is refused.
	for _, c := range []struct {
		value, text, want string // want "" = refused
	}{
		{`a"b`, `up{x="$n"}`, `up{x="a\"b"}`},
		{`a'b`, `up{x='$n'}`, `up{x='a\'b'}`},
		{"a`b", "up{x=`$n`}", ""},
		{`a}b`, `up{x=~"$n"}`, `up{x=~"(?-i:(?:a\\}b))"}`},
		{`a,b`, `up{x="$n"}`, `up{x="a,b"}`},
		{`a|b`, "up{x=~`$n`}", "up{x=~`(?-i:(?:a\\|b))`}"},
		{"a\nb", `up{x="$n"}`, `up{x="a\nb"}`},
		{`a#b`, `up{x="$n"}`, `up{x="a#b"}`},
	} {
		up.reset()
		vs, _ := json.Marshal(map[string]any{"n": map[string]any{"values": []string{c.value}}})
		rec := postJSON(h, variablesPath, valuesRequest("promql", "label_values("+c.text+", job)", `,"vars":`+string(vs)))
		if c.want == "" {
			wantError(t, "chained "+c.value, rec, 400, "invalid", "/vars/n", "variable.unrepresentable")
			if n := len(up.requests()); n != 0 {
				t.Errorf("chained %q: %d upstream requests", c.value, n)
			}
			continue
		}
		if v := variableValuesOf(t, rec.Body.Bytes()); rec.Code != 200 || v.Planned == nil || v.Planned.Match == nil || *v.Planned.Match != c.want {
			t.Errorf("chained %q: %d %s", c.value, rec.Code, rec.Body.String())
		}
		wantCall(t, "chained "+c.value, up, "/api/v1/label/job/values", url.Values{"match[]": {c.want}, "start": {"0"}, "end": {"60"}, "limit": {"1000"}})
	}

	up.reset()
	for _, c := range []struct {
		name, path, body string
		status           int
		code, pointer    string
		key              string
	}{
		{"missing variable", variablesPath, valuesRequest("promql", `label_values(up{a="$x"}, b)`, ""), 400, "invalid", "/vars/x", "variable.missing"},
		{"reserved metric", variablesPath, valuesRequest("promql", "label_values(ALERTS, alertname)", ""), 400, "virtual_unsupported", "/query", "query.reserved"},
		{"reserved source", variablesPath, valuesRequest("logql", `label_values({source="pulsus-dash"}, a)`, ""), 400, "virtual_unsupported", "/query", "query.reserved"},
		{"not label_values", variablesPath, valuesRequest("promql", "values(x)", ""), 400, "invalid", "/query", "query.invalid"},
		{"not a selector", variablesPath, valuesRequest("promql", "label_values(rate(x[5m]), a)", ""), 400, "invalid", "/query", "query.invalid"},
		{"a pipeline", variablesPath, valuesRequest("logql", `label_values({a="b"} |= "x", c)`, ""), 400, "invalid", "/query", "query.invalid"},
		{"two selectors", variablesPath, valuesRequest("logql", `label_values({a="b"} or {c="d"}, c)`, ""), 400, "invalid", "/query", "query.invalid"},
		{"multi at the top level", variablesPath, valuesRequest("promql", `label_values(up{a="$x"}, b)`, `,"vars":{"x":{"values":["a","b"]}}`), 400, "invalid", "/vars/x", "variable.unrepresentable"},
		{"to over the log bound", variablesPath, `{"lang":"logql","query":"label_values(a)","from":1,"to":9223372036855}`, 400, "invalid", "/to", "field.range"},
		{"from after to", variablesPath, `{"lang":"promql","query":"label_values(a)","from":2,"to":1}`, 400, "invalid", "/to", "field.range"},
		{"limit 0", variablesPath, valuesRequest("promql", "label_values(a)", `,"limit":0`), 400, "invalid", "/limit", "field.range"},
		{"lang", variablesPath, valuesRequest("traceql", "label_values(a)", ""), 400, "invalid", "/lang", "field.range"},
		{"missing query", variablesPath, `{"lang":"promql","from":1,"to":2}`, 400, "invalid", "/query", "field.required"},
		{"unknown field", variablesPath, valuesRequest("promql", "label_values(a)", `,"x":1`), 400, "invalid", "/x", "field.unknown"},
		{"no selector, a bad variable name", variablesPath, valuesRequest("promql", "label_values(a)", `,"vars":{"a-b":"1"}`), 400, "invalid", "/vars/a-b", "field.pattern"},
		{"no selector, no values", variablesPath, valuesRequest("logql", "label_values(a)", `,"vars":{"n":{"values":[]}}`), 400, "invalid", "/vars/n", "field.range"},
		{"no selector, a value over 4096 bytes", variablesPath, valuesRequest("promql", "label_values(a)", `,"vars":{"n":"`+strings.Repeat("x", 4097)+`"}`), 400, "invalid", "/vars/n", "field.range"},
		{"structured vars type", variablesPath, valuesRequest("promql", "label_values(a)", `,"vars":{"n":{"x":1}}`), 400, "invalid", "/vars/n", "field.type"},
		{"unknown tenant", "/api/dash/v1/variables/values?tenant=nope", valuesRequest("promql", "label_values(a)", ""), 404, "not_found", "-", ""},
		{"no tenant", "/api/dash/v1/variables/values", valuesRequest("promql", "label_values(a)", ""), 400, "invalid", "", "tenant.invalid"},
	} {
		wantError(t, c.name, postJSON(h, c.path, c.body), c.status, c.code, c.pointer, c.key)
	}
	if n := len(up.requests()); n != 0 {
		t.Errorf("%d upstream requests for refused bodies", n)
	}

	// A restricted data scope is refused by the client's scope check: nothing is sent.
	prev := dataScope
	dataScope = func() core.DataScope {
		return core.ScopedTenant(core.ScopeClause{Attrs: map[string][]string{"env": {"staging"}}})
	}
	defer func() { dataScope = prev }()
	wantError(t, "restricted scope", postJSON(h, variablesPath, valuesRequest("promql", "label_values(a)", "")), 403, "scope_denied", "-", "")
	if n := len(up.requests()); n != 0 {
		t.Errorf("restricted scope: %d upstream requests", n)
	}
}
