package gateway

import (
	"bytes"
	"crypto/ed25519"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/digitalis-io/pulsus-dash/server/internal/gateway/static"
	"github.com/digitalis-io/pulsus-dash/server/internal/gateway/static/statictest"
)

// The document headers of plan #59 B.4, verbatim (ADR-0014 §9 as amended by ADR-0026, T18-002).
var wantDocumentHeaders = [][2]string{
	{"Content-Security-Policy", "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; img-src 'self' data: blob:; " +
		"font-src 'self'; connect-src 'self'; worker-src 'self'; manifest-src 'self'; base-uri 'none'; " +
		"form-action 'self'; object-src 'none'; frame-ancestors 'none'; require-trusted-types-for 'script'; " +
		"trusted-types pulsus-sanitised pulsus-engine; report-to csp"},
	{"Reporting-Endpoints", `csp="/api/dash/v1/csp-report"`},
	{"Cross-Origin-Opener-Policy", "same-origin"},
	{"Cross-Origin-Embedder-Policy", "require-corp"},
	{"Cross-Origin-Resource-Policy", "same-origin"},
	{"Strict-Transport-Security", "max-age=63072000; includeSubDomains; preload"},
	{"X-Content-Type-Options", "nosniff"},
	{"Referrer-Policy", "strict-origin-when-cross-origin"},
	{"Permissions-Policy", "camera=(), geolocation=(), microphone=(self), usb=(), payment=(), gamepad=(self)"},
	{"Cache-Control", "no-cache"},
	{"Content-Type", "text/html; charset=utf-8"},
}

const notFoundBody = `{"error":{"code":"not_found","message":"not found"}}`

// testSet verifies the default statictest tree.
func testSet(t *testing.T) *static.Set {
	t.Helper()
	set, err := static.Verify(statictest.Default(), []ed25519.PublicKey{statictest.Public(statictest.Key())})
	if err != nil {
		t.Fatalf("Verify: %v", err)
	}
	return set
}

func assetHandler(t *testing.T) http.Handler {
	t.Helper()
	return New(Deps{Assets: testSet(t), Probe: &fakeProbe{version: 1}, SchemaLatest: 1})
}

func wantDocument(t *testing.T, rec *httptest.ResponseRecorder, body bool) {
	t.Helper()
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (body %q)", rec.Code, rec.Body.String())
	}
	for _, h := range wantDocumentHeaders {
		if got := rec.Header().Values(h[0]); len(got) != 1 || got[0] != h[1] {
			t.Errorf("%s = %q, want exactly %q", h[0], got, h[1])
		}
	}
	if body && !bytes.Equal(rec.Body.Bytes(), statictest.IndexHTML) {
		t.Errorf("body = %q, want index.html", rec.Body.String())
	}
	if !body && rec.Body.Len() != 0 {
		t.Errorf("HEAD body = %q, want empty", rec.Body.String())
	}
}

// H1
func TestDocumentHeaders(t *testing.T) {
	h := assetHandler(t)
	rec := do(h, http.MethodGet, "/", "Accept", "text/html,application/xhtml+xml")
	wantDocument(t, rec, true)
	if ce := rec.Header().Get("Content-Encoding"); ce != "" {
		t.Errorf("Content-Encoding = %q without Accept-Encoding", ce)
	}
}

// H2
func TestDeepLinkFallback(t *testing.T) {
	h := assetHandler(t)
	for _, p := range []string{"/t/demo/boards", "/t/demo/explore/logs?from=now-6h"} {
		t.Run(p, func(t *testing.T) {
			wantDocument(t, do(h, http.MethodGet, p, "Accept", "text/html"), true)
		})
	}
}

// H3
func TestAssetEncoding(t *testing.T) {
	h := assetHandler(t)
	cases := []struct {
		accept, encoding string
		body             []byte
	}{
		{"br, gzip", "br", statictest.AppBr},
		{"gzip", "gzip", statictest.AppGz},
		{"", "", statictest.AppJS},
		{"br;q=0, gzip", "gzip", statictest.AppGz},
	}
	etags := map[string]string{}
	for _, tc := range cases {
		t.Run("accept "+tc.accept, func(t *testing.T) {
			var hdr []string
			if tc.accept != "" {
				hdr = []string{"Accept-Encoding", tc.accept}
			}
			rec := do(h, http.MethodGet, "/assets/app.js", hdr...)
			if rec.Code != http.StatusOK {
				t.Fatalf("status = %d", rec.Code)
			}
			if got := rec.Header().Get("Content-Encoding"); got != tc.encoding {
				t.Errorf("Content-Encoding = %q, want %q", got, tc.encoding)
			}
			if !bytes.Equal(rec.Body.Bytes(), tc.body) {
				t.Errorf("body = %q, want %q", rec.Body.Bytes(), tc.body)
			}
			for k, v := range map[string]string{
				"Cache-Control":                "public, max-age=31536000, immutable",
				"Vary":                         "Accept-Encoding",
				"Cross-Origin-Resource-Policy": "same-origin",
				"Cross-Origin-Embedder-Policy": "require-corp",
				"X-Content-Type-Options":       "nosniff",
				"Content-Type":                 "text/javascript; charset=utf-8",
			} {
				if got := rec.Header().Get(k); got != v {
					t.Errorf("%s = %q, want %q", k, got, v)
				}
			}
			if csp := rec.Header().Get("Content-Security-Policy"); csp != "" {
				t.Errorf("an asset carries a CSP: %q", csp)
			}
			if rec.Header().Get("ETag") == "" {
				t.Error("no ETag")
			}
			etags[tc.encoding] = rec.Header().Get("ETag")
		})
	}
	if len(etags) != 3 || etags["br"] == etags["gzip"] || etags["br"] == etags[""] || etags["gzip"] == etags[""] {
		t.Errorf("ETags per encoding = %v, want three different values", etags)
	}
}

// H4
func TestNotFoundCases(t *testing.T) {
	h := assetHandler(t)
	for _, tc := range []struct {
		method, path string
		hdr          []string
	}{
		{http.MethodGet, "/api/nope", []string{"Accept", "text/html"}},
		{http.MethodGet, "/auth/login", []string{"Accept", "text/html"}},
		{http.MethodGet, "/assets/none.js", nil},
		{http.MethodGet, "/x.png", []string{"Accept", "image/*"}},
		{http.MethodPost, "/", []string{"Accept", "text/html"}},
	} {
		t.Run(tc.method+" "+tc.path, func(t *testing.T) {
			wantJSON(t, do(h, tc.method, tc.path, tc.hdr...), http.StatusNotFound, notFoundBody)
		})
	}
}

// H5
func TestManifestServed(t *testing.T) {
	h := assetHandler(t)
	fsys := statictest.Default()
	for _, tc := range []struct{ path, file, ct string }{
		{"/asset-manifest.json", statictest.ManifestName, "application/json"},
		{"/asset-manifest.sig", statictest.SignatureName, "application/octet-stream"},
	} {
		rec := do(h, http.MethodGet, tc.path)
		if rec.Code != http.StatusOK {
			t.Errorf("%s: status %d", tc.path, rec.Code)
			continue
		}
		if !bytes.Equal(rec.Body.Bytes(), fsys[tc.file].Data) {
			t.Errorf("%s: body differs from the verified bytes", tc.path)
		}
		if got := rec.Header().Get("Content-Type"); got != tc.ct {
			t.Errorf("%s: Content-Type = %q, want %q", tc.path, got, tc.ct)
		}
		if got := rec.Header().Get("Cache-Control"); got != "no-cache" {
			t.Errorf("%s: Cache-Control = %q, want no-cache", tc.path, got)
		}
	}
}

// H6
func TestConditionalAndRange(t *testing.T) {
	h := assetHandler(t)
	wantDocument(t, do(h, http.MethodHead, "/", "Accept", "text/html"), false)

	br := do(h, http.MethodGet, "/assets/app.js", "Accept-Encoding", "br")
	eb := br.Header().Get("ETag")
	if eb == "" {
		t.Fatal("no ETag on the br response")
	}

	rec := do(h, http.MethodGet, "/assets/app.js", "Accept-Encoding", "gzip", "If-None-Match", eb)
	if rec.Code != http.StatusOK || !bytes.Equal(rec.Body.Bytes(), statictest.AppGz) {
		t.Errorf("gzip with the br validator: %d %q, want 200 with the gzip bytes", rec.Code, rec.Body.Bytes())
	}

	rec = do(h, http.MethodGet, "/assets/app.js", "Accept-Encoding", "br", "If-None-Match", eb)
	if rec.Code != http.StatusNotModified || rec.Body.Len() != 0 {
		t.Errorf("br with its own validator: %d %q, want 304", rec.Code, rec.Body.Bytes())
	}

	rec = do(h, http.MethodGet, "/assets/app.js", "Accept-Encoding", "br", "Range", "bytes=0-9")
	if rec.Code != http.StatusOK || !bytes.Equal(rec.Body.Bytes(), statictest.AppBr) {
		t.Errorf("br with Range: %d %q, want 200 with the full br bytes", rec.Code, rec.Body.Bytes())
	}
	if got := rec.Header().Get("Accept-Ranges"); got != "none" {
		t.Errorf("br Accept-Ranges = %q, want none", got)
	}
	if got := rec.Header().Get("Content-Range"); got != "" {
		t.Errorf("br Content-Range = %q, want none", got)
	}

	rec = do(h, http.MethodGet, "/assets/app.js", "Range", "bytes=0-9")
	if rec.Code != http.StatusPartialContent || !bytes.Equal(rec.Body.Bytes(), statictest.AppJS[:10]) {
		t.Errorf("identity with Range: %d %q, want 206 with 10 bytes", rec.Code, rec.Body.Bytes())
	}
}

// H7
func TestAPIOnlyFallback(t *testing.T) {
	h := New(Deps{Probe: &fakeProbe{version: 1}, SchemaLatest: 1})
	wantJSON(t, do(h, http.MethodGet, "/", "Accept", "text/html"), http.StatusNotFound, notFoundBody)
	wantJSON(t, do(h, http.MethodGet, "/assets/app.js"), http.StatusNotFound, notFoundBody)
}
