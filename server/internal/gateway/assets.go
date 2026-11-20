package gateway

import (
	"bytes"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/digitalis-io/pulsus-dash/server/internal/gateway/api"
	"github.com/digitalis-io/pulsus-dash/server/internal/gateway/static"
)

// documentCSP is ADR-0014 §9 verbatim; it is byte-identical to CSP in client/config/headers.ts
// (e2e:bff-headers compares them in the browser).
const documentCSP = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; " +
	"font-src 'self'; connect-src 'self'; worker-src 'self'; manifest-src 'self'; base-uri 'none'; " +
	"form-action 'self'; object-src 'none'; frame-ancestors 'none'; require-trusted-types-for 'script'; " +
	"trusted-types pulsus-sanitised; report-to csp"

// documentHeaders are set on every HTML document, in this order (T18-002, T03-022).
var documentHeaders = [][2]string{
	{"Content-Security-Policy", documentCSP},
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

// Cache policies of non-document files (plan #59 B.4).
const (
	cacheImmutable  = "public, max-age=31536000, immutable" // under assets/: content-hashed names
	cacheRevalidate = "no-cache"                            // root files, the manifest and its signature
)

// assets serves the verified set: /assets/*, the root files, the manifest and signature, and
// index.html for HTML navigations (plan #59 §3.4). A nil set serves nothing.
type assets struct{ set *static.Set }

// serveAsset handles /assets/* for every method.
func (a assets) serveAsset(w http.ResponseWriter, r *http.Request) {
	if a.set == nil || (r.Method != http.MethodGet && r.Method != http.MethodHead) {
		notFound(w, r)
		return
	}
	f, ok := a.set.Lookup(strings.TrimPrefix(r.URL.Path, "/"))
	if !ok {
		notFound(w, r)
		return
	}
	writeFile(w, r, f, cacheImmutable)
}

// fallback is the router's NotFound handler: the rows of plan #59 §3.4 after the routed ones.
func (a assets) fallback(w http.ResponseWriter, r *http.Request) {
	p := r.URL.Path
	switch {
	case p == "/api" || strings.HasPrefix(p, "/api/"), strings.HasPrefix(p, "/auth/"):
		notFound(w, r)
		return
	case a.set == nil || (r.Method != http.MethodGet && r.Method != http.MethodHead):
		notFound(w, r)
		return
	case p == "/asset-manifest.json":
		writeBytes(w, r, a.set.Manifest, "application/json")
		return
	case p == "/asset-manifest.sig":
		writeBytes(w, r, a.set.Signature, "application/octet-stream")
		return
	}
	if name := strings.TrimPrefix(p, "/"); name != "" && name != "index.html" && !strings.Contains(name, "/") {
		if f, ok := a.set.Lookup(name); ok {
			writeFile(w, r, f, cacheRevalidate)
			return
		}
	}
	if strings.Contains(r.Header.Get("Accept"), "text/html") {
		if f, ok := a.set.Lookup("index.html"); ok {
			h := w.Header()
			for _, kv := range documentHeaders {
				h.Set(kv[0], kv[1])
			}
			writeRep(w, r, f)
			return
		}
	}
	notFound(w, r)
}

func notFound(w http.ResponseWriter, _ *http.Request) {
	WriteError(w, http.StatusNotFound, api.NotFound, "not found")
}

// assetHeaders are the headers of every non-document file (T18-002: CORP and nosniff only).
func assetHeaders(h http.Header, contentType, cache string) {
	h.Set("Content-Type", contentType)
	h.Set("Cache-Control", cache)
	h.Set("Cross-Origin-Resource-Policy", "same-origin")
	h.Set("X-Content-Type-Options", "nosniff")
}

func writeFile(w http.ResponseWriter, r *http.Request, f *static.File, cache string) {
	assetHeaders(w.Header(), f.ContentType, cache)
	writeRep(w, r, f)
}

// writeBytes serves the manifest or the signature: the exact verified bytes, identity only.
func writeBytes(w http.ResponseWriter, r *http.Request, b []byte, contentType string) {
	assetHeaders(w.Header(), contentType, cacheRevalidate)
	writeRep(w, r, &static.File{Identity: static.NewRep(b)})
}

// writeRep negotiates the representation of f and writes it (plan #59 §3.4, validators and
// ranges). Content-Type and Cache-Control are already set.
func writeRep(w http.ResponseWriter, r *http.Request, f *static.File) {
	h := w.Header()
	if f.Br != nil || f.Gz != nil {
		h.Set("Vary", "Accept-Encoding")
	}
	rep, encoding := negotiate(r.Header.Get("Accept-Encoding"), f)
	h.Set("ETag", rep.ETag)
	if encoding == "" {
		// Identity: HEAD, Range (206) and If-None-Match (304) by the standard library.
		http.ServeContent(w, r, "", time.Time{}, bytes.NewReader(rep.Bytes))
		return
	}
	h.Set("Content-Encoding", encoding)
	h.Set("Accept-Ranges", "none")
	if noneMatch(r.Header.Get("If-None-Match"), rep.ETag) {
		h.Del("Content-Type")
		h.Del("Content-Length")
		w.WriteHeader(http.StatusNotModified)
		return
	}
	h.Set("Content-Length", strconv.Itoa(len(rep.Bytes)))
	w.WriteHeader(http.StatusOK)
	if r.Method != http.MethodHead {
		_, _ = w.Write(rep.Bytes)
	}
}

// negotiate picks br if accepted and present, else gzip, else identity. A coding with q=0 is
// refused.
func negotiate(acceptEncoding string, f *static.File) (static.Rep, string) {
	accepted := map[string]bool{}
	for _, part := range strings.Split(acceptEncoding, ",") {
		coding, params, _ := strings.Cut(part, ";")
		coding = strings.ToLower(strings.TrimSpace(coding))
		if coding == "" {
			continue
		}
		accepted[coding] = !zeroQ(params)
	}
	switch {
	case f.Br != nil && accepted["br"]:
		return *f.Br, "br"
	case f.Gz != nil && accepted["gzip"]:
		return *f.Gz, "gzip"
	}
	return f.Identity, ""
}

// zeroQ reports whether params (";q=0.000") set q to zero.
func zeroQ(params string) bool {
	for _, p := range strings.Split(params, ";") {
		k, v, ok := strings.Cut(strings.TrimSpace(p), "=")
		if !ok || !strings.EqualFold(strings.TrimSpace(k), "q") {
			continue
		}
		q, err := strconv.ParseFloat(strings.TrimSpace(v), 64)
		return err == nil && q == 0
	}
	return false
}

// noneMatch reports whether If-None-Match matches etag (weak comparison, RFC 9110 §13.1.2).
func noneMatch(header, etag string) bool {
	for _, t := range strings.Split(header, ",") {
		t = strings.TrimPrefix(strings.TrimSpace(t), "W/")
		if t == "*" || t == etag {
			return true
		}
	}
	return false
}
