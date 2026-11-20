package gateway

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/digitalis-io/pulsus-dash/server/internal/core"
	"github.com/digitalis-io/pulsus-dash/server/internal/pulsusdb"
)

// goldenNow is Deps.Now of the query tests (A.5): 30 s after the counter's last sample.
var goldenNow = time.UnixMilli(1767229230000)

var (
	testOrg       = core.OrgID(uuid.MustParse("01900000-0000-7000-8000-0000000000aa"))
	demoBindingID = uuid.MustParse("01900000-0000-7000-8000-000000000001")
)

// queryGateway is a gateway whose bootstrap org has the binding demo at url (mod may change it)
// and whose PulsusDB client has options o. Logs are JSON at debug.
func queryGateway(t *testing.T, url string, o pulsusdb.Options, mod ...func(*core.TenantBinding)) (http.Handler, *syncBuffer) {
	t.Helper()
	b := core.TenantBinding{OrgID: testOrg, ID: demoBindingID, Slug: "demo", DatasourceURL: url, Kind: "pulsusdb"}
	for _, m := range mod {
		m(&b)
	}
	logs := &syncBuffer{}
	logger := slog.New(slog.NewJSONHandler(logs, &slog.HandlerOptions{Level: slog.LevelDebug}))
	o.Logger = logger
	view := core.BootstrapView{Org: core.Org{ID: testOrg, Slug: "default", Name: "Default organisation"}, Bindings: []core.TenantBinding{b}}
	return New(Deps{
		Logger: logger, Probe: &fakeProbe{version: 1}, SchemaLatest: 1,
		Bootstrap: func(context.Context) (core.BootstrapView, error) { return view, nil },
		Now:       func() time.Time { return goldenNow },
		PulsusDB:  pulsusdb.New(o),
	}), logs
}

func withCredentials(ref string) func(*core.TenantBinding) {
	return func(b *core.TenantBinding) { b.CredentialsRef = ref }
}

func secretsMap(m map[string]string) func(string) (string, error) {
	return func(ref string) (string, error) {
		if v, ok := m[ref]; ok {
			return v, nil
		}
		return "", io.EOF
	}
}

// postJSON sends body to path on h.
func postJSON(h http.Handler, path, body string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(http.MethodPost, path, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

// envelope decodes an error envelope.
type envelope struct {
	Error struct {
		Code    string         `json:"code"`
		Message string         `json:"message"`
		Hint    map[string]any `json:"hint"`
		QueryID string         `json:"query_id"`
		Fields  []struct {
			Pointer    string `json:"pointer"`
			MessageKey string `json:"message_key"`
		} `json:"fields"`
	} `json:"error"`
}

func envelopeOf(t *testing.T, b []byte) envelope {
	t.Helper()
	var e envelope
	if err := json.Unmarshal(b, &e); err != nil {
		t.Fatalf("body %q is not an envelope: %v", b, err)
	}
	return e
}

// wantError checks status, code, and (if pointer != "-") the first field's pointer and key.
func wantError(t *testing.T, what string, rec *httptest.ResponseRecorder, status int, code, pointer, key string) envelope {
	t.Helper()
	if rec.Code != status {
		t.Errorf("%s: status %d, want %d (body %s)", what, rec.Code, status, rec.Body.String())
		return envelope{}
	}
	e := envelopeOf(t, rec.Body.Bytes())
	if e.Error.Code != code {
		t.Errorf("%s: code %q, want %q (body %s)", what, e.Error.Code, code, rec.Body.String())
	}
	if pointer != "-" {
		if len(e.Error.Fields) != 1 || e.Error.Fields[0].Pointer != pointer || e.Error.Fields[0].MessageKey != key {
			t.Errorf("%s: fields %+v, want [{%s %s}]", what, e.Error.Fields, pointer, key)
		}
	}
	return e
}

const (
	rangePath   = "/api/dash/v1/query/promql/range?tenant=demo"
	instantPath = "/api/dash/v1/query/promql/instant?tenant=demo"
	counterReq  = `{"query":"sum by (job, instance) (rate(http_requests_total[5m]))","from":1767225600000,"to":1767229200000,"width_px":1200}`
)

func (b *syncBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.String()
}
