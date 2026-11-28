package gateway

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/digitalis-io/pulsus-dash/server/internal/core"
	"github.com/digitalis-io/pulsus-dash/server/internal/pulsusdb"
)

// emptyUpstream answers every query_range with an empty matrix and records its form.
func emptyUpstream(t *testing.T) (string, func() []map[string]string) {
	t.Helper()
	var mu sync.Mutex
	var seen []map[string]string
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = r.ParseForm()
		f := map[string]string{"path": r.URL.Path}
		for k := range r.Form {
			f[k] = r.Form.Get(k)
		}
		mu.Lock()
		seen = append(seen, f)
		mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"status":"success","data":{"resultType":"matrix","result":[]}}`)
	}))
	t.Cleanup(up.Close)
	return up.URL, func() []map[string]string {
		mu.Lock()
		defer mu.Unlock()
		return append([]map[string]string(nil), seen...)
	}
}

// step_ms and range_ms (#304 §A.1): a ladder step is the upstream step over the aligned window;
// an off-ladder step is a 400 on /step_ms; range_ms is the window the range macros see.
func TestRangeStepMs(t *testing.T) {
	url, seen := emptyUpstream(t)
	h, _ := queryGateway(t, url, pulsusdb.Options{})
	rec := postJSON(h, rangePath, `{"query":"up","from":1767225601234,"to":1767229201234,"width_px":300,"step_ms":15000}`)
	if rec.Code != 200 {
		t.Fatalf("%d %s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), `"start":1767225600000,"end":1767229215000,"step":15000`) {
		t.Errorf("grid %.300s", rec.Body.String())
	}
	got := seen()
	if len(got) != 1 || got[0]["step"] != "15" || got[0]["start"] != "1767225600" || got[0]["end"] != "1767229215" {
		t.Errorf("upstream %+v", got)
	}
	off := postJSON(h, rangePath, `{"query":"up","from":1767225600000,"to":1767229200000,"width_px":1200,"step_ms":20000}`)
	wantError(t, "off ladder", off, 400, "invalid", "/step_ms", "field.range")
	long := postJSON(h, rangePath, `{"query":"up","from":0,"to":180000000,"width_px":1200,"step_ms":15000}`)
	wantError(t, "too long", long, 400, "invalid", "/from", "range.too_long")
	mac := postJSON(h, rangePath, `{"query":"vector($__range_ms)","from":1767225600000,"to":1767229200000,"width_px":1200,"step_ms":15000,"range_ms":86400000}`)
	if mac.Code != 200 {
		t.Fatalf("%d %s", mac.Code, mac.Body.String())
	}
	var body struct {
		Planned struct{ Expanded string } `json:"planned"`
	}
	if err := json.Unmarshal(mac.Body.Bytes(), &body); err != nil || body.Planned.Expanded != "vector(86400000)" {
		t.Errorf("expanded %q %v", body.Planned.Expanded, err)
	}
}

// scope_epoch headers (#304 §A.2): every range response after tenant resolution carries the
// epoch and sequence the BFF used, the error responses too.
func TestRangeScopeHeaders(t *testing.T) {
	url, _ := emptyUpstream(t)
	h, _ := queryGateway(t, url, pulsusdb.Options{}, func(b *core.TenantBinding) { b.ScopeSeq = 4 })
	want := core.ScopeEpoch(core.LocalPrincipal.ID, core.TenantBinding{OrgID: pdbOrg, ID: demoBindingID,
		Slug: "demo", DatasourceURL: url, Kind: "pulsusdb", ScopeSeq: 4}, core.FullTenantScope())
	for _, c := range []struct {
		name, body string
		status     int
	}{
		{"ok", `{"query":"up","from":1767225600000,"to":1767229200000,"width_px":1200}`, 200},
	} {
		rec := postJSON(h, rangePath, c.body)
		if rec.Code != c.status {
			t.Errorf("%s: %d %s", c.name, rec.Code, rec.Body.String())
		}
		if rec.Code == 200 && (rec.Header().Get("X-Pulsus-Scope-Epoch") != want || rec.Header().Get("X-Pulsus-Scope-Seq") != "4") {
			t.Errorf("%s: headers %q %q, want %q 4", c.name, rec.Header().Get("X-Pulsus-Scope-Epoch"), rec.Header().Get("X-Pulsus-Scope-Seq"), want)
		}
	}
	// A denied scope is a 403 with the headers of the scope that was denied.
	restore := dataScope
	dataScope = func() core.DataScope {
		return core.ScopedTenant(core.ScopeClause{Attrs: map[string][]string{"team": {"a"}}})
	}
	defer func() { dataScope = restore }()
	rec := postJSON(h, rangePath, `{"query":"up","from":1767225600000,"to":1767229200000,"width_px":1200}`)
	if rec.Code != 403 || rec.Header().Get("X-Pulsus-Scope-Epoch") == "" || rec.Header().Get("X-Pulsus-Scope-Epoch") == want {
		t.Errorf("denied: %d %q", rec.Code, rec.Header().Get("X-Pulsus-Scope-Epoch"))
	}
}
