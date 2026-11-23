package pulsusdb

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"testing"
	"time"
	"unicode/utf8"

	"github.com/digitalis-io/pulsus-dash/server/internal/core"
)

// The probe of PulsusDB's LogQL lexer (plan #121 §3.4, §4.2) and its recorder. The recorder writes
// only files built from constants and validated facts, never received bytes (§4.4).

// lexerCase is one probe text and the answer PulsusDB 0.0.13 gave at design time.
type lexerCase struct {
	id, query  string // query is sent byte for byte
	status     int    // 200 or 400
	message    string // the exact text/plain body of a 400
	transcript string // "logs-fffd-dq", "logs-fffd-bq" or ""
}

// fffd is U+FFFD, the replacement character, as UTF-8.
const fffd = "\uFFFD"

// hashMsg is PulsusDB's refusal of a '#' at byte n.
func hashMsg(n int) string {
	return "unexpected '#' at byte " + strconv.Itoa(n) + ": expected a valid LogQL token"
}

// lexerCases are the rows of plan #121 §4.2, in order.
var lexerCases = []lexerCase{
	{id: "P1", query: "{app=\"xyz\"} # c", status: 400, message: hashMsg(12)},
	{id: "P2", query: "# c\r{app=\"x\"}", status: 400, message: hashMsg(0)},
	{id: "P3", query: "{app=\"x\"} # c\r)", status: 400, message: hashMsg(10)},
	{id: "P4", query: "{app=\"x\"} # c\n)", status: 400, message: hashMsg(10)},
	{id: "P5", query: "{app=\"x\"}\r|= \"y\"", status: 200},
	{id: "P6", query: "{app=\"x" + fffd + "y\"}", status: 200, transcript: "logs-fffd-dq"},
	{id: "P7", query: "{app=`x" + fffd + "y`}", status: 200, transcript: "logs-fffd-bq"},
	{id: "P8", query: "{app=\"x" + fffd + "y\"} )", status: 400, message: "unexpected trailing input at byte 14"},
	{id: "P9", query: "{app=`x" + fffd + "y`} )", status: 400, message: "unexpected trailing input at byte 14"},
	{id: "P10", query: "{app=\"x\\ufffdy\"}", status: 200},
	{id: "P11", query: "{app=\"x\"} " + fffd, status: 400, message: "unexpected '" + fffd + "' at byte 10: expected a valid LogQL token"},
	{id: "P12", query: "{app=\"#\"}", status: 200},
}

// probeResult is one answer as received: nothing of it is ever written or printed.
type probeResult struct {
	status int
	ctype  string
	body   []byte
}

// maxProbeBody bounds every probe body read.
const maxProbeBody = 64 << 10

// The probe's fixed errors: a reason code each, never a wrapped transport error, URL or response
// value. (errTooLarge is the package's body-limit error, so these carry a probe prefix.)
var (
	errProbeRequest   = errors.New("request")
	errProbeTransport = errors.New("transport")
	errProbeRead      = errors.New("read")
	errProbeTooLarge  = errors.New("too large")
)

// probeGet sends one GET through the client's transport, decorated as cl says, and reads the
// body only through io.LimitReader(resp.Body, maxProbeBody+1).
func probeGet(ctx context.Context, c *Client, rc *core.RequestCtx, cl call, form url.Values) (probeResult, error) {
	cred, err := c.credential(ctx, rc)
	if err != nil {
		return probeResult{}, errProbeRequest
	}
	req, err := c.request(ctx, rc.Tenant.Binding, cl, form, cred)
	if err != nil {
		return probeResult{}, errProbeRequest
	}
	resp, err := c.http.Do(req) // #nosec G704 -- the contract binding's configured URL, from the environment
	if err != nil {
		return probeResult{}, errProbeTransport
	}
	defer func() { _ = resp.Body.Close() }()
	b, err := io.ReadAll(io.LimitReader(resp.Body, maxProbeBody+1))
	if err != nil {
		return probeResult{}, errProbeRead
	}
	if len(b) > maxProbeBody {
		return probeResult{}, errProbeTooLarge
	}
	return probeResult{status: resp.StatusCode, ctype: resp.Header.Get("Content-Type"), body: b}, nil
}

// rawLogResponse sends one GET /api/logs/v1/query_range, decorated as a page request
// (categorize flag, tenant header, credential), and returns its status, Content-Type and body
// (at most maxProbeBody bytes), undecoded.
func rawLogResponse(ctx context.Context, c *Client, rc *core.RequestCtx, form url.Values) (probeResult, error) {
	return probeGet(ctx, c, rc, call{method: http.MethodGet, path: "/api/logs/v1/query_range", categorize: true}, form)
}

// rawBuildInfo is GET /api/v1/status/buildinfo by the same rules.
func rawBuildInfo(ctx context.Context, c *Client, rc *core.RequestCtx) (probeResult, error) {
	return probeGet(ctx, c, rc, call{method: http.MethodGet, path: "/api/v1/status/buildinfo"}, nil)
}

// runLexer is the whole collection path: every case over (now-5m, now], limit 1, backward; the
// build info; synthesise; and, when dir is not "", writeAll. Its error is "<id>: <reason code>"
// or synthesise's error.
func runLexer(ctx context.Context, c *Client, rc *core.RequestCtx, cases []lexerCase, secrets []string, date, dir string) error {
	now := time.Now().UnixNano()
	got := make([]probeResult, 0, len(cases))
	for _, lc := range cases {
		form := url.Values{"query": {lc.query}, "start": {nsParam(now - int64(5*time.Minute))}, "end": {nsParam(now)},
			"limit": {"1"}, "direction": {"backward"}}
		r, err := rawLogResponse(ctx, c, rc, form)
		if err != nil {
			return errors.New(lc.id + ": " + err.Error())
		}
		got = append(got, r)
	}
	bi, err := rawBuildInfo(ctx, c, rc)
	if err != nil {
		return errors.New("buildinfo: " + err.Error())
	}
	files, err := synthesise(cases, got, bi, secrets, date)
	if err != nil {
		return err
	}
	if dir == "" {
		return nil
	}
	if err := writeAll(dir, files); err != nil {
		return errors.New("write: " + err.Error())
	}
	return nil
}

// reason is a diagnostic of synthesise: a case id and a reason code, nothing else (§4.4).
func reason(id, code string) error { return errors.New(id + ": " + code) }

var versionRE = regexp.MustCompile(`^[0-9]+\.[0-9]+\.[0-9]+$`)

// lexBody is the only shape a 200 may have (§4.4): any other member fails the decode.
type lexBody struct {
	Status string `json:"status"`
	Data   *struct {
		ResultType    string             `json:"resultType"`
		EncodingFlags []string           `json:"encodingFlags"`
		Result        *[]json.RawMessage `json:"result"`
		Stats         *struct {
			Streams *int64 `json:"streams"`
			Entries *int64 `json:"entries"`
			Bytes   *int64 `json:"bytes"`
		} `json:"stats"`
	} `json:"data"`
}

// check200 validates a 200 body; flags reports whether it had encodingFlags.
func check200(body []byte, secrets []string) (flags bool, code string) {
	dec := json.NewDecoder(bytes.NewReader(body))
	dec.DisallowUnknownFields()
	var b lexBody
	if err := dec.Decode(&b); err != nil {
		if strings.HasPrefix(err.Error(), "json: unknown field") {
			return false, "unknown field"
		}
		return false, "body"
	}
	if _, err := dec.Token(); !errors.Is(err, io.EOF) {
		return false, "body"
	}
	if stringsLeak(body, secrets) {
		return false, "leak"
	}
	d := b.Data
	switch {
	case b.Status != "success" || d == nil || d.ResultType != "streams" || d.Result == nil || d.Stats == nil:
		return false, "body"
	case len(*d.Result) != 0:
		return false, "result not empty"
	case d.Stats.Streams == nil || d.Stats.Entries == nil || d.Stats.Bytes == nil ||
		*d.Stats.Streams != 0 || *d.Stats.Entries != 0 || *d.Stats.Bytes != 0:
		return false, "stats not zero"
	case len(d.EncodingFlags) > 1 || (len(d.EncodingFlags) == 1 && d.EncodingFlags[0] != categorizeValue):
		return false, "flag not allowed"
	}
	return len(d.EncodingFlags) == 1, ""
}

// stringsLeak reports whether any decoded JSON string or member name of body holds a secret.
func stringsLeak(body []byte, secrets []string) bool {
	dec := json.NewDecoder(bytes.NewReader(body))
	dec.UseNumber()
	for {
		tok, err := dec.Token()
		if err != nil {
			return false
		}
		if s, ok := tok.(string); ok && leaks([]byte(s), secrets) {
			return true
		}
	}
}

// buildVersion is data.version of a 200 application/json build info, when it is a plain
// x.y.z; the only member read.
func buildVersion(bi probeResult, secrets []string) (string, bool) {
	if bi.status != http.StatusOK || bi.ctype != "application/json" || leaks(bi.body, secrets) {
		return "", false
	}
	var doc struct {
		Data struct {
			Version string `json:"version"`
		} `json:"data"`
	}
	if json.Unmarshal(bi.body, &doc) != nil || !versionRE.MatchString(doc.Data.Version) {
		return "", false
	}
	return doc.Data.Version, true
}

// The transcripts' match queries, as JSON string contents (plan #121 §3.5).
var transcriptQuery = map[string]string{
	"logs-fffd-dq": `{app=\"x\ufffdy\"}`,
	"logs-fffd-bq": "{app=`x\\ufffdy`}",
}

// transcriptFile is the §3.5 text of one transcript.
func transcriptFile(name, date, version string, flags bool) []byte {
	fl := ""
	if flags {
		fl = `"encodingFlags":["categorize-labels"],`
	}
	return []byte("{\n" +
		`  "name": "` + name + `",` + "\n" +
		`  "provenance": {"captured": "` + date + `", "pulsusdb": "` + version + `", "route": "/api/logs/v1/query_range", "sanitised": "synthesised from validated fields: status, resultType, an empty result"},` + "\n" +
		`  "match": {"method": "GET", "paths": ["/api/logs/v1/query_range"], "query": "` + transcriptQuery[name] + `"},` + "\n" +
		`  "response": {` + "\n" +
		`    "status": 200,` + "\n" +
		`    "headers": {"Content-Type": "application/json", "X-Pulsus-Query-Id": "fake-` + name + `-1"},` + "\n" +
		`    "body": {"status":"success","data":{"resultType":"streams",` + fl + `"result":[],"stats":{"streams":0,"entries":0,"bytes":0}}}` + "\n" +
		"  }\n}\n")
}

var dateRE = regexp.MustCompile(`^[0-9]{4}-[0-9]{2}-[0-9]{2}$`)

// synthesise validates every result against its case and builds the files to write: the two
// transcripts and lexer-transcript.txt, all from constants and validated facts, never from
// received bytes. Any failure returns (nil, err); err names case ids and reason codes only.
func synthesise(cases []lexerCase, got []probeResult, buildinfo probeResult, secrets []string, date string) (map[string][]byte, error) {
	if len(got) != len(cases) {
		return nil, reason("probe", "count")
	}
	if !dateRE.MatchString(date) {
		return nil, reason("probe", "date")
	}
	version, ok := buildVersion(buildinfo, secrets)
	if !ok {
		return nil, reason("buildinfo", "version withheld")
	}
	files := map[string][]byte{}
	var txt strings.Builder
	txt.WriteString("pulsusdb " + version + ", GET /api/logs/v1/query_range, " + date + " UTC\n")
	for i, lc := range cases {
		r := got[i]
		if r.status != lc.status {
			return nil, reason(lc.id, "status")
		}
		if leaks(r.body, secrets) {
			return nil, reason(lc.id, "leak")
		}
		line := lc.id + " query=" + strconv.Quote(lc.query) + " status=" + strconv.Itoa(lc.status)
		switch lc.status {
		case http.StatusBadRequest:
			if r.ctype != "text/plain; charset=utf-8" {
				return nil, reason(lc.id, "content type")
			}
			if string(r.body) != lc.message {
				return nil, reason(lc.id, "message differs")
			}
			line += " message=" + strconv.Quote(lc.message)
		case http.StatusOK:
			if r.ctype != "application/json" {
				return nil, reason(lc.id, "content type")
			}
			flags, code := check200(r.body, secrets)
			if code != "" {
				return nil, reason(lc.id, code)
			}
			if lc.transcript != "" {
				files[lc.transcript+".json"] = transcriptFile(lc.transcript, date, version, flags)
			}
			line += " result=empty streams"
		default:
			return nil, reason(lc.id, "status")
		}
		txt.WriteString(line + "\n")
	}
	files["lexer-transcript.txt"] = []byte(txt.String())
	for name, b := range files {
		if leaks(b, secrets) {
			return nil, reason(name, "leak")
		}
	}
	return files, nil
}

// leaks reports whether b holds any secret in any encoding of §4.4: b as is, lowercased,
// percent-decoded up to three times, and with \uXXXX, \xHH and &#…; escapes decoded, each against
// every secret (lowercased), its percent-encodings and its standard and URL base64.
func leaks(b []byte, secrets []string) bool {
	var needles []string
	for _, s := range secrets {
		if s == "" {
			continue
		}
		for _, n := range []string{s, url.QueryEscape(s), url.PathEscape(s),
			base64.StdEncoding.EncodeToString([]byte(s)), base64.URLEncoding.EncodeToString([]byte(s)),
			base64.RawStdEncoding.EncodeToString([]byte(s)), base64.RawURLEncoding.EncodeToString([]byte(s))} {
			needles = append(needles, strings.ToLower(n))
		}
	}
	if len(needles) == 0 {
		return false
	}
	v := string(b)
	variants := []string{v, unescapes(v)}
	for range 3 {
		v = percentDecode(v)
		variants = append(variants, v, unescapes(v))
	}
	for _, x := range variants {
		x = strings.ToLower(x)
		for _, n := range needles {
			if strings.Contains(x, n) {
				return true
			}
		}
	}
	return false
}

func hexVal(c byte) rune {
	switch {
	case c >= '0' && c <= '9':
		return rune(c - '0')
	case c >= 'a' && c <= 'f':
		return rune(c-'a') + 10
	case c >= 'A' && c <= 'F':
		return rune(c-'A') + 10
	}
	return -1
}

// hexByte is the byte of the two hex digits at s[i:].
func hexByte(s string, i int) (byte, bool) {
	if i+2 > len(s) {
		return 0, false
	}
	d, err := hex.DecodeString(s[i : i+2])
	if err != nil {
		return 0, false
	}
	return d[0], true
}

// percentDecode decodes every valid %HH of s and leaves the rest as is.
func percentDecode(s string) string {
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		if s[i] == '%' {
			if v, ok := hexByte(s, i+1); ok {
				b.WriteByte(v)
				i += 2
				continue
			}
		}
		b.WriteByte(s[i])
	}
	return b.String()
}

// unescapes decodes every \uXXXX, \xHH, &#NNN; and &#xHH; of s and leaves the rest as is.
func unescapes(s string) string {
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		switch {
		case s[i] == '\\' && i+1 < len(s) && s[i+1] == 'u':
			if r, n := digits(s[i+2:], 16, 4); n == 4 {
				b.WriteRune(r)
				i += 5
				continue
			}
		case s[i] == '\\' && i+1 < len(s) && s[i+1] == 'x':
			if v, ok := hexByte(s, i+2); ok {
				b.WriteByte(v)
				i += 3
				continue
			}
		case s[i] == '&' && i+2 < len(s) && s[i+1] == '#':
			if r, n := entity(s[i+2:]); n > 0 {
				b.WriteRune(r)
				i += 1 + n // with the loop's i++, past the "&#" and the n bytes
				continue
			}
		}
		b.WriteByte(s[i])
	}
	return b.String()
}

// digits reads at most max digits of base at the start of s: their value and how many it read.
// It stops before a value past utf8.MaxRune.
func digits(s string, base rune, maxDigits int) (rune, int) {
	var v rune
	k := 0
	for k < len(s) && k < maxDigits {
		d := hexVal(s[k])
		if d < 0 || d >= base || v > (utf8.MaxRune-d)/base {
			break
		}
		v = v*base + d
		k++
	}
	return v, k
}

// entity reads the rest of a numeric character reference after "&#" (NNN; or xHH;): its rune and
// the bytes it read (the ';' included), or n 0.
func entity(s string) (rune, int) {
	var base rune = 10
	j := 0
	if j < len(s) && (s[j] == 'x' || s[j] == 'X') {
		base, j = 16, 1
	}
	v, n := digits(s[j:], base, 8)
	k := j + n
	if n == 0 || k >= len(s) || s[k] != ';' {
		return 0, 0
	}
	return v, k + 1
}

// writeAll writes every file or none: dir must exist, be empty and lie outside the repository.
// Each file is written to dir/.<name>.tmp, and all are renamed once every write succeeded; on any
// error every file it wrote is removed.
func writeAll(dir string, files map[string][]byte) (err error) {
	abs, err := filepath.Abs(dir)
	if err != nil {
		return errors.New("dir")
	}
	if st, serr := os.Stat(abs); serr != nil || !st.IsDir() { // #nosec G703 -- the test's or DASH_CONTRACT_RECORD_DIR
		return errors.New("dir")
	}
	if es, rerr := os.ReadDir(abs); rerr != nil || len(es) != 0 {
		return errors.New("dir not empty")
	}
	root, err := filepath.Abs("../../..")
	if err != nil {
		return errors.New("root")
	}
	if under(abs, root) {
		return errors.New("dir in the repository")
	}
	names := make([]string, 0, len(files))
	for n := range files {
		names = append(names, n)
	}
	slices.Sort(names)
	var written []string
	defer func() {
		if err != nil {
			for _, p := range written {
				_ = os.Remove(p) // #nosec G703 -- a file this call wrote in dir
			}
		}
	}()
	for _, n := range names {
		if n == "" || filepath.Base(n) != n || strings.HasPrefix(n, ".") {
			return errors.New("name")
		}
		tmp := filepath.Join(abs, "."+n+".tmp")
		// #nosec G703 -- dir is the test's or DASH_CONTRACT_RECORD_DIR, checked above; n is one of the recorder's names, checked by filepath.Base
		if werr := os.WriteFile(tmp, files[n], 0o600); werr != nil {
			_ = os.Remove(tmp) // #nosec G703 -- the temporary file just named
			return errors.New("write")
		}
		written = append(written, tmp)
	}
	for _, n := range names {
		tmp, final := filepath.Join(abs, "."+n+".tmp"), filepath.Join(abs, n)
		if rerr := os.Rename(tmp, final); rerr != nil { // #nosec G703 -- both in dir, named by the recorder
			return errors.New("rename")
		}
		written = slices.DeleteFunc(written, func(p string) bool { return p == tmp })
		written = append(written, final)
	}
	return nil
}

// under reports whether p is root or inside it, symbolic links resolved where they exist.
func under(p, root string) bool {
	if r, err := filepath.EvalSymlinks(root); err == nil {
		root = r
	}
	if q, err := filepath.EvalSymlinks(p); err == nil {
		p = q
	}
	rel, err := filepath.Rel(root, p)
	return err == nil && rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator))
}

// probeSecrets are the values no recorded file or diagnostic may hold (plan #121 §3.4): the base
// URL, the URL without its scheme, its host name and host, the org and the credential.
func probeSecrets(base, org, cred string) []string {
	out := []string{base}
	if u, err := url.Parse(base); err == nil {
		out = append(out, strings.TrimPrefix(base, u.Scheme+"://"), u.Hostname(), u.Host)
	}
	out = append(out, org, cred)
	return slices.DeleteFunc(out, func(s string) bool { return s == "" })
}

// emptyStreamsBody is the empty 200 answer of the design-time probe.
const emptyStreamsBody = `{"status":"success","data":{"resultType":"streams","encodingFlags":["categorize-labels"],"result":[],"stats":{"streams":0,"entries":0,"bytes":0}}}`

// wantFFFDdq is the §3.5 text of logs-fffd-dq for 2026-01-01 and PulsusDB 0.0.0.
const wantFFFDdq = `{
  "name": "logs-fffd-dq",
  "provenance": {"captured": "2026-01-01", "pulsusdb": "0.0.0", "route": "/api/logs/v1/query_range", "sanitised": "synthesised from validated fields: status, resultType, an empty result"},
  "match": {"method": "GET", "paths": ["/api/logs/v1/query_range"], "query": "{app=\"x\ufffdy\"}"},
  "response": {
    "status": 200,
    "headers": {"Content-Type": "application/json", "X-Pulsus-Query-Id": "fake-logs-fffd-dq-1"},
    "body": {"status":"success","data":{"resultType":"streams","encodingFlags":["categorize-labels"],"result":[],"stats":{"streams":0,"entries":0,"bytes":0}}}
  }
}
`

// answerOf is the design-time answer of a case.
func answerOf(lc lexerCase) probeResult {
	if lc.status == http.StatusBadRequest {
		return probeResult{status: 400, ctype: "text/plain; charset=utf-8", body: []byte(lc.message)}
	}
	return probeResult{status: 200, ctype: "application/json", body: []byte(emptyStreamsBody)}
}

func goodResults() []probeResult {
	out := make([]probeResult, 0, len(lexerCases))
	for _, lc := range lexerCases {
		out = append(out, answerOf(lc))
	}
	return out
}

func buildInfoOf(version string) probeResult {
	return probeResult{status: 200, ctype: "application/json",
		body: []byte(`{"status":"success","data":{"version":"` + version + `","revision":"r","goVersion":"go"}}`)}
}

// caseIndex is the index of the case id in lexerCases.
func caseIndex(t *testing.T, id string) int {
	t.Helper()
	i := slices.IndexFunc(lexerCases, func(lc lexerCase) bool { return lc.id == id })
	if i < 0 {
		t.Fatalf("no case %s", id)
	}
	return i
}

func dirNames(t *testing.T, dir string) []string {
	t.Helper()
	es, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	out := make([]string, 0, len(es))
	for _, e := range es {
		out = append(out, e.Name())
	}
	return out
}

// noSecret fails when the error text holds any secret in any encoding leaks knows.
func noSecret(t *testing.T, what string, err error, secrets []string, extra ...string) {
	t.Helper()
	if err == nil {
		return
	}
	if leaks([]byte(err.Error()), append(slices.Clone(secrets), extra...)) {
		t.Errorf("%s: the error %q holds a secret", what, err)
	}
}

// unit:lexer-record (plan #121 §5.1): the recorder writes only synthesised, validated files,
// refuses any secret in any encoding and writes all files or none.
func TestLexerRecord(t *testing.T) {
	host := "probe-secret-host"
	secrets := []string{host, host + ":9999", "http" + "://" + host + ":9999"}
	date, bi := "2026-01-01", buildInfoOf("0.0.0")

	t.Run("ok", func(t *testing.T) {
		files, err := synthesise(lexerCases, goodResults(), bi, secrets, date)
		if err != nil || len(files) != 3 {
			t.Fatalf("synthesise: %d files, %v; want 3", len(files), err)
		}
		if got := string(files["logs-fffd-dq.json"]); got != wantFFFDdq {
			t.Errorf("logs-fffd-dq.json\n%s\nwant\n%s", got, wantFFFDdq)
		}
		if bq := string(files["logs-fffd-bq.json"]); !strings.Contains(bq, `"query": "{app=`+"`x\\ufffdy`"+`}"`) || !strings.Contains(bq, "fake-logs-fffd-bq-1") {
			t.Errorf("logs-fffd-bq.json\n%s", bq)
		}
		txt := string(files["lexer-transcript.txt"])
		if !strings.HasPrefix(txt, "pulsusdb 0.0.0, GET /api/logs/v1/query_range, 2026-01-01 UTC\n") ||
			!strings.Contains(txt, "\nP1 query=\"{app=\\\"xyz\\\"} # c\" status=400 message=\"unexpected '#' at byte 12: expected a valid LogQL token\"\n") ||
			!strings.Contains(txt, "\nP12 query=\"{app=\\\"#\\\"}\" status=200 result=empty streams\n") || strings.Count(txt, "\n") != 13 {
			t.Errorf("lexer-transcript.txt\n%s", txt)
		}
		dir := t.TempDir()
		if err := writeAll(dir, files); err != nil {
			t.Fatalf("writeAll: %v", err)
		}
		if names := dirNames(t, dir); !slices.Equal(names, []string{"lexer-transcript.txt", "logs-fffd-bq.json", "logs-fffd-dq.json"}) {
			t.Errorf("files %v", names)
		}
		if b, err := os.ReadFile(filepath.Join(dir, "logs-fffd-dq.json")); err != nil || string(b) != wantFFFDdq { // #nosec G304 -- the test's temporary directory
			t.Errorf("written logs-fffd-dq.json: %v", err)
		}
	})

	t.Run("no flags", func(t *testing.T) {
		got := goodResults()
		got[caseIndex(t, "P6")].body = []byte(`{"status":"success","data":{"resultType":"streams","result":[],"stats":{"streams":0,"entries":0,"bytes":0}}}`)
		files, err := synthesise(lexerCases, got, bi, secrets, date)
		if err != nil || strings.Contains(string(files["logs-fffd-dq.json"]), "encodingFlags") ||
			!strings.Contains(string(files["logs-fffd-bq.json"]), `"encodingFlags":["categorize-labels"]`) {
			t.Errorf("synthesise without flags: %v\n%s", err, files["logs-fffd-dq.json"])
		}
	})

	b64 := base64.StdEncoding.EncodeToString([]byte(host))
	for _, c := range []struct {
		name, id, ctype, body, want string
	}{
		{"encoded host: a \\u escape", "P6", "application/json",
			`{"status":"success","warnings":["probe\u002dsecret-host"],"data":{"resultType":"streams","result":[],"stats":{"streams":0,"entries":0,"bytes":0}}}`, "P6: leak"},
		{"encoded host: percent-encoded", "P1", "text/plain; charset=utf-8", "unexpected '#' at byte 12: probe%2Dsecret-host", "P1: leak"},
		{"encoded host: base64 in a flag", "P6", "application/json",
			`{"status":"success","data":{"resultType":"streams","encodingFlags":["` + b64 + `"],"result":[],"stats":{"streams":0,"entries":0,"bytes":0}}}`, "P6: leak"},
		{"non-empty result", "P6", "application/json",
			`{"status":"success","data":{"resultType":"streams","result":[{"stream":{"app":"x"},"values":[["1","secret-line"]]}],"stats":{"streams":0,"entries":0,"bytes":0}}}`, "P6: result not empty"},
		{"unknown field", "P6", "application/json",
			`{"status":"success","data":{"resultType":"streams","extra":1,"result":[],"stats":{"streams":0,"entries":0,"bytes":0}}}`, "P6: unknown field"},
		{"stats not zero", "P6", "application/json",
			`{"status":"success","data":{"resultType":"streams","result":[],"stats":{"streams":0,"entries":1,"bytes":0}}}`, "P6: stats not zero"},
		{"flag not allowed", "P6", "application/json",
			`{"status":"success","data":{"resultType":"streams","encodingFlags":["other"],"result":[],"stats":{"streams":0,"entries":0,"bytes":0}}}`, "P6: flag not allowed"},
		{"trailing data", "P6", "application/json", emptyStreamsBody + `{}`, "P6: body"},
		{"content type", "P6", "application/json; charset=utf-8", emptyStreamsBody, "P6: content type"},
		{"message differs", "P8", "text/plain; charset=utf-8", "unexpected trailing input at byte 13", "P8: message differs"},
		{"status", "P5", "text/plain; charset=utf-8", "x", "P5: status"},
	} {
		t.Run(c.name, func(t *testing.T) {
			got := goodResults()
			i := caseIndex(t, c.id)
			got[i] = probeResult{status: got[i].status, ctype: c.ctype, body: []byte(c.body)}
			if c.name == "status" {
				got[i].status = 400
			}
			files, err := synthesise(lexerCases, got, bi, secrets, date)
			if files != nil || err == nil || err.Error() != c.want {
				t.Errorf("synthesise: %d files, %v; want %q", len(files), err, c.want)
			}
			noSecret(t, c.name, err, secrets, "secret-line")
		})
	}

	t.Run("no files on failure", func(t *testing.T) {
		got := goodResults()
		got[caseIndex(t, "P12")] = probeResult{status: 400, ctype: "text/plain; charset=utf-8", body: []byte("x")}
		dir := t.TempDir()
		files, err := synthesise(lexerCases, got, bi, secrets, date)
		if err == nil {
			if werr := writeAll(dir, files); werr != nil {
				t.Errorf("writeAll: %v", werr)
			}
		}
		if files != nil || err == nil || err.Error() != "P12: status" {
			t.Errorf("synthesise: %d files, %v; want P12: status", len(files), err)
		}
		if names := dirNames(t, dir); len(names) != 0 {
			t.Errorf("files %v after a failure", names)
		}
	})

	t.Run("writeAll", func(t *testing.T) {
		files, err := synthesise(lexerCases, goodResults(), bi, secrets, date)
		if err != nil {
			t.Fatal(err)
		}
		full := t.TempDir()
		keep := filepath.Join(full, "keep.txt")
		if err := os.WriteFile(keep, []byte("keep"), 0o600); err != nil {
			t.Fatal(err)
		}
		if err := writeAll(full, files); err == nil {
			t.Error("writeAll to a non-empty dir: nil error")
		}
		if b, err := os.ReadFile(keep); err != nil || string(b) != "keep" || len(dirNames(t, full)) != 1 { // #nosec G304 -- the test's temporary directory
			t.Errorf("non-empty dir changed: %q %v %v", b, err, dirNames(t, full))
		}
		inRepo, err := os.MkdirTemp(".", ".lexer-record-")
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = os.RemoveAll(inRepo) })
		if err := writeAll(inRepo, files); err == nil {
			t.Error("writeAll to a dir in the repository: nil error")
		}
		if names := dirNames(t, inRepo); len(names) != 0 {
			t.Errorf("files %v in the repository", names)
		}
		nul := t.TempDir()
		if err := writeAll(nul, map[string][]byte{"a.json": []byte("a"), "b.json": []byte("b"), "c\x00.json": []byte("c")}); err == nil {
			t.Error("writeAll with a NUL name: nil error")
		}
		if names := dirNames(t, nul); len(names) != 0 {
			t.Errorf("files %v after a failed write", names)
		}
		if err := writeAll(filepath.Join(nul, "missing"), files); err == nil {
			t.Error("writeAll to a missing dir: nil error")
		}
	})

	t.Run("version", func(t *testing.T) {
		for _, v := range []string{"0.0.13-x/y", "", "v0.0.13"} {
			files, err := synthesise(lexerCases, goodResults(), buildInfoOf(v), secrets, date)
			if files != nil || err == nil || err.Error() != "buildinfo: version withheld" {
				t.Errorf("version %q: %d files, %v; want version withheld", v, len(files), err)
			}
		}
		if _, err := synthesise(lexerCases, goodResults()[1:], bi, secrets, date); err == nil || err.Error() != "probe: count" {
			t.Errorf("count: %v", err)
		}
	})

	t.Run("leaks", func(t *testing.T) {
		for _, b := range []string{host, "PROBE-SECRET-HOST", "probe%2Dsecret-host", "probe%252Dsecret-host", "probe\\x2dsecret-host", "probe\\u002Dsecret-host",
			"probe&#45;secret-host", "probe&#x2d;secret-host", b64, base64.URLEncoding.EncodeToString([]byte(host + ":9999")),
			url.QueryEscape(secrets[2])} {
			if !leaks([]byte("a "+b+" z"), secrets) {
				t.Errorf("leaks(%q) = false", b)
			}
		}
		if leaks([]byte("probe-secret"), secrets) || leaks([]byte(host), nil) {
			t.Error("leaks without a secret")
		}
	})
}

// lexerServer answers every probe case as §4.2 and the build info as 0.0.13, except where
// override answers (it returns true).
func lexerServer(t *testing.T, override func(w http.ResponseWriter, r *http.Request, id string) bool) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/v1/status/buildinfo":
			w.Header().Set("Content-Type", "application/json")
			_, _ = io.WriteString(w, `{"status":"success","data":{"version":"0.0.13"}}`)
			return
		case "/api/logs/v1/query_range":
		default:
			http.NotFound(w, r)
			return
		}
		q := r.URL.Query()
		i := slices.IndexFunc(lexerCases, func(lc lexerCase) bool { return lc.query == q.Get("query") })
		if i < 0 || q.Get("limit") != "1" || q.Get("direction") != "backward" || r.Header.Get(categorizeHeader) != categorizeValue {
			http.Error(w, "unexpected probe", http.StatusTeapot)
			return
		}
		if override != nil && override(w, r, lexerCases[i].id) {
			return
		}
		a := answerOf(lexerCases[i])
		w.Header().Set("Content-Type", a.ctype)
		w.WriteHeader(a.status)
		_, _ = w.Write(a.body)
	}))
	t.Cleanup(srv.Close)
	return srv
}

// unit:lexer-record, the full path (plan #121 §5.1 TestLexerRunPath): runLexer against an
// httptest server, through the probe's own bounded reads.
func TestLexerRunPath(t *testing.T) {
	answer := func(id, ctype, body string) func(http.ResponseWriter, *http.Request, string) bool {
		return func(w http.ResponseWriter, _ *http.Request, got string) bool {
			if got != id {
				return false
			}
			w.Header().Set("Content-Type", ctype)
			_, _ = io.WriteString(w, body)
			return true
		}
	}
	// 64 KiB + 2 bytes: the secret once before the 64 KiB mark and once across it, ending after it.
	over := `{"status":"success","x":"probe-secret-host`
	over += strings.Repeat("a", maxProbeBody+2-len(over)-len("probe-secret-host")) + "probe-secret-host"
	if len(over) != maxProbeBody+2 || !strings.HasSuffix(over[:maxProbeBody], "probe-secret-ho") {
		t.Fatalf("oversized body of %d bytes", len(over))
	}
	for _, c := range []struct {
		name     string
		override func(http.ResponseWriter, *http.Request, string) bool
		want     []string // any of
		hidden   []string // never in the error
	}{
		{"a truncated body", answer("P6", "application/json", `{"status":"success","data":{"resultType":"probe-secret-host","result":[{"stream":`),
			[]string{"P6: unknown field", "P6: body"}, []string{"probe-secret-host"}},
		{"b a non-empty result", answer("P6", "application/json",
			`{"status":"success","data":{"resultType":"streams","result":[{"stream":{"app":"secret-label"},"values":[["1","secret-line"]]}],"stats":{"streams":1,"entries":1,"bytes":11}}}`),
			[]string{"P6: result not empty"}, []string{"secret-label", "secret-line"}},
		{"c a closed connection", func(w http.ResponseWriter, _ *http.Request, id string) bool {
			if id != "P3" {
				return false
			}
			conn, _, err := http.NewResponseController(w).Hijack()
			if err == nil {
				_ = conn.Close()
			}
			return true
		}, []string{"P3: transport"}, nil},
		{"d all as designed", nil, nil, nil},
		{"e oversized", answer("P6", "application/json", over), []string{"P6: too large"}, []string{"probe-secret-host"}},
	} {
		t.Run(c.name, func(t *testing.T) {
			srv := lexerServer(t, c.override)
			secrets := probeSecrets(srv.URL, "", "")
			cl := New(Options{Transport: http.DefaultTransport.(*http.Transport).Clone()})
			dir := t.TempDir()
			err := runLexer(ctxWithin(t, 30*time.Second), cl, rcFor(testBinding(srv.URL)), lexerCases, secrets, "2026-01-01", dir)
			names := dirNames(t, dir)
			if c.want == nil {
				if err != nil || !slices.Equal(names, []string{"lexer-transcript.txt", "logs-fffd-bq.json", "logs-fffd-dq.json"}) {
					t.Fatalf("runLexer: %v, files %v", err, names)
				}
				if b, _ := os.ReadFile(filepath.Join(dir, "lexer-transcript.txt")); !strings.HasPrefix(string(b), "pulsusdb 0.0.13, GET ") { // #nosec G304 -- the test's temporary directory
					t.Errorf("lexer-transcript.txt %q", b)
				}
				return
			}
			if err == nil || !slices.Contains(c.want, err.Error()) {
				t.Errorf("runLexer: %v, want one of %q", err, c.want)
			}
			noSecret(t, c.name, err, secrets, c.hidden...)
			if err != nil && strings.Contains(err.Error(), "http") {
				t.Errorf("runLexer: %q names a URL", err)
			}
			if len(names) != 0 {
				t.Errorf("files %v after a failure", names)
			}
		})
	}
}
