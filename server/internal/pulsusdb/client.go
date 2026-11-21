// Package pulsusdb is the only code that calls PulsusDB (T06-005). Every method takes the
// request's context (deadline and the browser's cancellation) and its *core.RequestCtx (the
// resolved tenant binding and a non-optional data scope, T06-002). Requests are decorated from
// the binding only (T06-006), limited per binding, retried only before response headers or on
// 503 unavailable under a 10 % retry budget (T06-009), and every body decoder yields upstream
// strings only through the request's redactor (§4.9 of plan #62).
package pulsusdb

import (
	"context"
	"crypto/hmac"
	crand "crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"io"
	"log/slog"
	"math/rand/v2"
	"mime"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/digitalis-io/pulsus-dash/server/internal/core"
)

// Options configure a Client.
type Options struct {
	TenantConcurrency int                                              // per binding ID; 1..1024; config pulsusdb.tenant_concurrency (0 = 16)
	Secrets           func(ref string) (string, error)                 // resolves TenantBinding.CredentialsRef
	Logger            *slog.Logger                                     // nil = discard
	Now               func() time.Time                                 // nil = time.Now (retry budget and timeout clock)
	Sleep             func(ctx context.Context, d time.Duration) error // nil = timer; returns ctx.Err() if cancelled
	Jitter            func() float64                                   // nil = math/rand/v2 Float64; [0,1)
	Transport         http.RoundTripper                                // nil = the pooled transport of newTransport
	Limits            Limits                                           // zero fields = DefaultLimits
	Timeouts          Timeouts                                         // zero fields = DefaultTimeouts
}

// Limits bound everything read from PulsusDB.
type Limits struct {
	DataBody, MetaBody, ErrorBody int64 // bytes: range and instant; the others; non-2xx
	MaxPoints                     int   // grid points per response
	MaxValues                     int   // values or series per completion response
	TextBytes, MaxMessages        int   // bytes per error/warning/info/help text; warnings and infos kept
	LineBytes                     int   // bytes per log line; a longer line is cut at a UTF-8 boundary + "…" (#65 §4.3)
	PageBytes                     int64 // Σ line + label bytes of one log response; more → KindTooBroad
	MaxEntries                    int   // log entries decoded from one response; more → KindProtocol
	CaptureBytes                  int   // a result captured because it came before resultType (#65 §4.1)
}

// DefaultLimits are the production limits.
var DefaultLimits = Limits{
	DataBody: 256 << 20, MetaBody: 32 << 20, ErrorBody: 64 << 10,
	MaxPoints: 5_000_000, MaxValues: 10_000, TextBytes: 1024, MaxMessages: 20,
	LineBytes: 65_536, PageBytes: 64 << 20, MaxEntries: 5_000, CaptureBytes: 96 << 20,
}

// Timeouts apply when the caller's ctx has a later (or no) deadline; the earlier always wins.
type Timeouts struct {
	Metadata time.Duration // Series, Labels, LabelValues, Metadata
	Check    time.Duration // RuntimeInfo
}

// DefaultTimeouts are the production timeouts.
var DefaultTimeouts = Timeouts{Metadata: 10 * time.Second, Check: 5 * time.Second}

const (
	maxAttempts    = 3
	timeoutReserve = 100 * time.Millisecond // kept back from the upstream timeout parameter
	backoffBase    = 50 * time.Millisecond
	backoffJitter  = 350 * time.Millisecond
	noDeadline     = 120 * time.Second // the budget of a call whose ctx has no deadline
	clientTimeout  = 130 * time.Second // absolute backstop above the 120 s maximum
)

// Client calls PulsusDB. It is safe for concurrent use.
type Client struct {
	o       Options
	http    *http.Client
	limiter *tenantLimiter
	budget  *retryBudget
}

// New returns a client; zero options take their defaults.
func New(o Options) *Client {
	if o.TenantConcurrency < 1 {
		o.TenantConcurrency = 16
	}
	if o.Logger == nil {
		o.Logger = slog.New(slog.DiscardHandler)
	}
	if o.Now == nil {
		o.Now = time.Now
	}
	if o.Sleep == nil {
		o.Sleep = sleepCtx
	}
	if o.Jitter == nil {
		o.Jitter = rand.Float64
	}
	if o.Transport == nil {
		o.Transport = newTransport()
	}
	o.Limits = withDefaults(o.Limits)
	if o.Timeouts.Metadata <= 0 {
		o.Timeouts.Metadata = DefaultTimeouts.Metadata
	}
	if o.Timeouts.Check <= 0 {
		o.Timeouts.Check = DefaultTimeouts.Check
	}
	return &Client{
		o: o,
		http: &http.Client{Transport: o.Transport, Timeout: clientTimeout,
			CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }},
		limiter: &tenantLimiter{n: o.TenantConcurrency},
		budget:  newRetryBudget(),
	}
}

func withDefaults(l Limits) Limits {
	d := DefaultLimits
	set64 := func(v *int64, def int64) {
		if *v <= 0 {
			*v = def
		}
	}
	set := func(v *int, def int) {
		if *v <= 0 {
			*v = def
		}
	}
	set64(&l.DataBody, d.DataBody)
	set64(&l.MetaBody, d.MetaBody)
	set64(&l.ErrorBody, d.ErrorBody)
	set(&l.MaxPoints, d.MaxPoints)
	set(&l.MaxValues, d.MaxValues)
	set(&l.TextBytes, d.TextBytes)
	set(&l.MaxMessages, d.MaxMessages)
	set(&l.LineBytes, d.LineBytes)
	set64(&l.PageBytes, d.PageBytes)
	set(&l.MaxEntries, d.MaxEntries)
	set(&l.CaptureBytes, d.CaptureBytes)
	return l
}

// newTransport is the pooled transport of plan #62 §3.3.
func newTransport() *http.Transport {
	return &http.Transport{
		Proxy:                 http.ProxyFromEnvironment,
		DialContext:           (&net.Dialer{Timeout: 5 * time.Second, KeepAlive: 30 * time.Second}).DialContext,
		ForceAttemptHTTP2:     true,
		MaxIdleConnsPerHost:   64,
		MaxConnsPerHost:       64,
		IdleConnTimeout:       90 * time.Second,
		TLSHandshakeTimeout:   5 * time.Second,
		ResponseHeaderTimeout: 125 * time.Second,
		ExpectContinueTimeout: time.Second,
	}
}

func sleepCtx(ctx context.Context, d time.Duration) error {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-t.C:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

// call describes one upstream route.
type call struct {
	route   string // the log's route=
	method  string
	path    string
	form    url.Values
	inputs  []guardInput
	query   string // the query text, for the error position
	limit   int64  // 2xx body limit
	retry   bool
	timeout bool // send the timeout parameter (range, instant)
	cut     int  // values or series kept by a completion call (MaxValues, or a log call's Limit)
	// postOver: a GET whose URL would be longer than maxGetQuery is sent as a POST form instead
	// (the log query_range and series calls, #65).
	postOver bool
}

// maxGetQuery bounds the URL of a GET call that may fall back to a POST form: a conservative
// limit below the 8 KiB request-line limit common to HTTP servers and proxies.
const maxGetQuery = 8 << 10

// response is an upstream 2xx response with its slot held.
type response struct {
	body     io.ReadCloser // capped at call.limit
	format   bodyFormat    // from Content-Type; selects the decoder (newSource)
	red      redactor
	hdr      upstreamHeaders
	rawID    string // the raw X-Pulsus-Query-Id, for the log's HMAC only
	release  func()
	status   int
	attempts int
}

// close drains nothing, closes the body and frees the slot; it is idempotent.
func (r *response) close() {
	_ = r.body.Close()
	r.release()
}

// ctxError maps the caller's ctx error: Canceled (the browser went away) passes through,
// a deadline is KindTimeout.
func ctxError(ctx context.Context) error {
	if errors.Is(ctx.Err(), context.Canceled) {
		return context.Canceled
	}
	return newError(KindTimeout)
}

// readError classifies an error met while reading a 2xx body.
func readError(ctx context.Context, err error) error {
	var pe *Error
	if errors.As(err, &pe) {
		return pe
	}
	if ctx.Err() != nil {
		return ctxError(ctx)
	}
	return protocolError()
}

// do runs the checks of §4.1 step 6 in order (scope, reserved selectors, kind, credentials, the
// tenant slot), then the attempts. It returns a 2xx response, or the call's error.
func (c *Client) do(ctx context.Context, rc *core.RequestCtx, cl call) (*response, error) {
	if !rc.Scope.IsFullTenant() {
		return nil, newError(KindScopeDenied)
	}
	if e := guard(cl.inputs); e != nil {
		return nil, e
	}
	b := rc.Tenant.Binding
	if b.Kind != "pulsusdb" {
		return nil, newError(KindConfig)
	}
	cred, err := c.credential(ctx, rc)
	if err != nil {
		return nil, err
	}
	red := newRedactor(b, cred)
	release, err := c.limiter.acquire(ctx, b.ID)
	if err != nil {
		if ctx.Err() != nil {
			return nil, ctxError(ctx)
		}
		return nil, err
	}
	resp, attempts, last, err := c.attempts(ctx, rc, cl, cred, red)
	if err != nil {
		release()
		r := &response{attempts: attempts}
		var pe *Error
		if last != nil && errors.As(err, &pe) {
			r.rawID = last.Get("X-Pulsus-Query-Id")
			pe.QueryID = readHeaders(last, red).QueryID
		}
		return r, err
	}
	rawID := resp.Header.Get("X-Pulsus-Query-Id")
	hdr := readHeaders(resp.Header, red)
	if resp.StatusCode >= 200 && resp.StatusCode < 300 {
		f, ok := formatOf(resp.Header.Get("Content-Type"))
		if !ok {
			_ = resp.Body.Close()
			release()
			e := protocolError()
			e.Status, e.QueryID = resp.StatusCode, hdr.QueryID
			return &response{attempts: attempts, rawID: rawID}, e
		}
		return &response{body: closer{&capReader{r: resp.Body, left: cl.limit}, resp.Body}, format: f, red: red, hdr: hdr,
			rawID: rawID, release: release, status: resp.StatusCode, attempts: attempts}, nil
	}
	e := c.statusError(ctx, resp, red, hdr, cl)
	_ = resp.Body.Close()
	release()
	return &response{attempts: attempts, rawID: rawID, status: resp.StatusCode}, e
}

// closer reads through r and closes c.
type closer struct {
	io.Reader
	c io.Closer
}

func (c closer) Close() error { return c.c.Close() }

// credential resolves and checks the binding's credentials (§4.10): user:password with a
// non-empty user and a password core.WeakPassword accepts. "" when the binding has none.
func (c *Client) credential(ctx context.Context, rc *core.RequestCtx) (string, error) {
	b := rc.Tenant.Binding
	if b.CredentialsRef == "" {
		return "", nil
	}
	if c.o.Secrets == nil {
		return "", newError(KindConfig)
	}
	v, err := c.o.Secrets(b.CredentialsRef)
	if err != nil {
		// The resolution error names the reference, never the value; it is not logged.
		return "", newError(KindConfig)
	}
	user, pw, ok := strings.Cut(v, ":")
	if !ok || user == "" || core.WeakPassword(pw) {
		c.o.Logger.WarnContext(ctx, "pulsusdb_credentials_weak", "tenant", b.Slug)
		return "", newError(KindConfig)
	}
	return v, nil
}

// remaining is the time left before ctx's deadline on the client's clock.
func (c *Client) remaining(ctx context.Context) time.Duration {
	d, ok := ctx.Deadline()
	if !ok {
		return noDeadline
	}
	return d.Sub(c.o.Now())
}

// clusterKey is scheme://host:port of the binding, the retry budget's key.
func clusterKey(raw string) string {
	u, err := url.Parse(raw)
	if err != nil {
		return raw
	}
	port := u.Port()
	if port == "" {
		port = map[string]string{"https": "443"}[u.Scheme]
		if port == "" {
			port = "80"
		}
	}
	return u.Scheme + "://" + net.JoinHostPort(u.Hostname(), port)
}

// attempts sends the request, retrying per §4.3. It returns a response that is not a retryable
// 503, or the error of the last attempt with the headers of its response, if it had one.
func (c *Client) attempts(ctx context.Context, rc *core.RequestCtx, cl call, cred string, red redactor) (*http.Response, int, http.Header, error) {
	b := rc.Tenant.Binding
	cluster := clusterKey(b.DatasourceURL)
	limit := maxAttempts
	if !cl.retry {
		limit = 1
	}
	for n := 1; ; n++ {
		form := cl.form
		if cl.timeout {
			t := c.remaining(ctx).Truncate(time.Millisecond) - timeoutReserve
			if t < timeoutReserve {
				return nil, n - 1, nil, newError(KindTimeout)
			}
			form = cloneValues(cl.form)
			form.Set("timeout", strconv.FormatInt(t.Milliseconds(), 10)+"ms")
		}
		req, err := c.request(ctx, b, cl, form, cred)
		if err != nil {
			return nil, n - 1, nil, newError(KindConfig)
		}
		c.budget.record(cluster, c.o.Now(), n > 1)
		// The target is the tenant binding's datasource URL, set by the operator (T06-006).
		resp, err := c.http.Do(req) // #nosec G704 -- the binding's configured URL, not request input
		var last error
		var hdr http.Header
		switch {
		case err != nil && ctx.Err() != nil:
			return nil, n, nil, ctxError(ctx)
		case err != nil:
			last = newError(KindUnreachable)
		case resp.StatusCode == http.StatusServiceUnavailable:
			// errorType is read through the request's redactor, like every upstream string; it is
			// compared, never returned. A body that stalls, is cut or is malformed is classified.
			et, _, berr := c.readErrorBody(resp, red)
			_ = resp.Body.Close()
			hdr = resp.Header
			if berr != nil {
				if ctx.Err() != nil {
					return nil, n, hdr, ctxError(ctx)
				}
				e := protocolError()
				e.Status = resp.StatusCode
				return nil, n, hdr, e
			}
			e := newError(KindUnavailable)
			e.Status = resp.StatusCode
			if et != "unavailable" {
				if et == "timeout" {
					e = newError(KindTimeout)
					e.Status = resp.StatusCode
				}
				return nil, n, hdr, e
			}
			last = e
		default:
			return resp, n, nil, nil
		}
		if n >= limit || !c.budget.allow(cluster, c.o.Now()) {
			return nil, n, hdr, last
		}
		d := backoffBase + time.Duration(c.o.Jitter()*float64(backoffJitter))
		if c.remaining(ctx) < d+timeoutReserve {
			return nil, n, hdr, last
		}
		if err := c.o.Sleep(ctx, d); err != nil {
			return nil, n, hdr, ctxError(ctx)
		}
	}
}

func cloneValues(v url.Values) url.Values {
	out := make(url.Values, len(v)+1)
	for k, vs := range v {
		out[k] = append([]string(nil), vs...)
	}
	return out
}

// request builds one attempt, decorated from the binding only (T06-006).
func (c *Client) request(ctx context.Context, b core.TenantBinding, cl call, form url.Values, cred string) (*http.Request, error) {
	target := strings.TrimSuffix(b.DatasourceURL, "/") + cl.path
	method := cl.method
	enc := form.Encode()
	if method == http.MethodGet && cl.postOver && len(target)+1+len(enc) > maxGetQuery {
		method = http.MethodPost
	}
	var body io.Reader
	if method == http.MethodPost {
		body = strings.NewReader(enc)
	} else if len(form) > 0 {
		target += "?" + enc
	}
	req, err := http.NewRequestWithContext(ctx, method, target, body)
	if err != nil {
		return nil, err
	}
	h := req.Header
	h.Set("Accept", acceptHeader)
	h.Set("User-Agent", "pulsus-dash/"+core.Version)
	if method == http.MethodPost {
		h.Set("Content-Type", "application/x-www-form-urlencoded")
	}
	if b.ScopeOrgID != "" {
		h.Set("X-Scope-OrgID", b.ScopeOrgID)
	}
	if b.Database != "" {
		h.Set("X-Pulsus-Database", b.Database)
	}
	if cred != "" {
		h.Set("Authorization", "Basic "+base64.StdEncoding.EncodeToString([]byte(cred)))
	}
	return req, nil
}

// readErrorBody reads a non-2xx body (≤ ErrorBody) and returns its errorType and error text,
// redacted. A text/plain body (any charset) is the text itself, with no errorType (#65 §4.5);
// any other type is read as JSON. err is the read error (a deadline, a cancel, a cut
// connection, errTooLarge) or a protocol error when a JSON body is not one object.
func (c *Client) readErrorBody(resp *http.Response, red redactor) (errorType, msg string, err error) {
	if mt, _, perr := mime.ParseMediaType(resp.Header.Get("Content-Type")); perr == nil && mt == "text/plain" {
		msg, err = readTextBody(resp.Body, c.o.Limits.ErrorBody, red)
		return "", msg, err
	}
	d := newUpstreamDecoder(&capReader{r: resp.Body, left: c.o.Limits.ErrorBody}, red)
	k, err := d.Next()
	if err != nil {
		return "", "", err
	}
	if k != tokObjStart {
		return "", "", protocolError()
	}
	for {
		k, err := d.Next()
		if err != nil {
			return "", "", err
		}
		if k == tokObjEnd {
			break
		}
		key := d.String()
		if k, err = d.Next(); err != nil {
			return "", "", err
		}
		switch {
		case key == "errorType" && k == tokString:
			errorType = d.String()
		case key == "error" && k == tokString:
			msg = d.String()
		default:
			if err := d.Skip(); err != nil {
				return "", "", err
			}
		}
	}
	if k, err := d.Next(); err != nil || k != tokEOF {
		return "", "", orProtocol(err)
	}
	return errorType, msg, nil
}

// statusError maps a non-2xx, non-retried status (§4.3, §4.4).
func (c *Client) statusError(ctx context.Context, resp *http.Response, red redactor, hdr upstreamHeaders, cl call) error {
	_, msg, berr := c.readErrorBody(resp, red)
	if berr != nil && ctx.Err() != nil {
		return ctxError(ctx) // the deadline or the cancel arrived while the body was read
	}
	var e *Error
	switch s := resp.StatusCode; {
	case (s == http.StatusBadRequest || s == http.StatusUnprocessableEntity) && berr != nil:
		e = protocolError()
	case s == http.StatusBadRequest:
		e = newError(KindQueryInvalid)
		if msg != "" {
			e.Message = cleanText(msg, c.o.Limits.TextBytes)
		}
		if cl.query != "" {
			e.Position = positionOf(e.Message, cl.query)
		}
	case s == http.StatusUnprocessableEntity:
		e = newError(KindTooBroad)
		if msg != "" {
			e.Message = cleanText(msg, c.o.Limits.TextBytes)
		}
	case s == http.StatusTooManyRequests:
		e = newError(KindRateLimited)
		e.RetryAfter = hdr.RetryAfter
	case s == http.StatusUnauthorized || s == http.StatusForbidden:
		e = newError(KindUnauthorised)
	case s == http.StatusGatewayTimeout:
		e = newError(KindTimeout)
	default:
		e = protocolError()
	}
	e.Status, e.QueryID = resp.StatusCode, hdr.QueryID
	return e
}

// hmacKey is drawn once per process; the log's query_id_hash is an HMAC prefix under it, so the
// raw header value is never logged.
var hmacKey = sync.OnceValue(func() []byte {
	k := make([]byte, 32)
	_, _ = crand.Read(k)
	return k
})

func queryIDHash(raw string) string {
	if raw == "" {
		return ""
	}
	m := hmac.New(sha256.New, hmacKey())
	m.Write([]byte(raw))
	return hex.EncodeToString(m.Sum(nil))[:8]
}

// logCall writes the one record of a call: warn on failure, debug on success. It never carries
// an upstream value or text, the URL, credentials or the query (§4.4).
// extra are further key-value attributes (a log page's page_request).
func (c *Client) logCall(ctx context.Context, rc *core.RequestCtx, route string, start time.Time, r *response, err error, extra ...any) {
	attrs := []any{"route", route, "tenant", rc.Tenant.Binding.Slug}
	status, attempts, rawID, cache := 0, 0, "", ""
	if r != nil {
		status, attempts, rawID, cache = r.status, r.attempts, r.rawID, r.hdr.ReadCache
	}
	kind := "ok"
	var pe *Error
	switch {
	case errors.As(err, &pe):
		kind = pe.Kind.String()
		if pe.Status != 0 {
			status = pe.Status
		}
	case err != nil:
		kind = "cancelled"
	}
	attrs = append(attrs, "kind", kind, "status", status, "attempts", attempts,
		"duration_ms", time.Since(start).Milliseconds(), "query_id_present", rawID != "",
		"query_id_hash", queryIDHash(rawID), "request_id", rc.RequestID)
	attrs = append(attrs, extra...)
	switch {
	case pe != nil:
		c.o.Logger.WarnContext(ctx, "pulsusdb", attrs...)
	case err != nil:
		c.o.Logger.DebugContext(ctx, "pulsusdb", attrs...)
	default:
		c.o.Logger.DebugContext(ctx, "pulsusdb", append(attrs, "read_cache", cache)...)
	}
}

// formatSeconds is ms as PulsusDB seconds: whole seconds, plus .mmm only when ms%1000 ≠ 0.
func formatSeconds(t time.Time) string {
	ms := t.UnixMilli()
	s := strconv.FormatInt(ms/1000, 10)
	if r := ms % 1000; r != 0 {
		if r < 0 {
			r = -r
		}
		frac := strconv.FormatInt(1000+r, 10)[1:]
		s += "." + frac
	}
	return s
}
