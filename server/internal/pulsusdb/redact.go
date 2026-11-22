package pulsusdb

import (
	"cmp"
	"encoding/base64"
	"net/http"
	"net/url"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"unicode/utf8"

	"github.com/digitalis-io/pulsus-dash/server/internal/core"
)

// redactedText replaces every needle.
const redactedText = "<redacted>"

// maxDataString bounds data strings (labels, names, values) that are not text fields.
const maxDataString = 4096

// redactor replaces the binding's secrets and addresses in every string obtained from PulsusDB
// (§4.9). It is built once per request from the binding and the resolved credential.
type redactor struct {
	needles []string // longest first; empty strings never added
	rep     *strings.Replacer
}

// newRedactor collects the needles: the credential user:password, the password (any length),
// the base64 Basic token, the datasource URL, its scheme://host[:port] and its host[:port].
func newRedactor(b core.TenantBinding, credential string) redactor {
	var ns []string
	add := func(s string) {
		if s != "" && !slices.Contains(ns, s) {
			ns = append(ns, s)
		}
	}
	if credential != "" {
		add(credential)
		if _, pw, ok := strings.Cut(credential, ":"); ok {
			add(pw)
		}
		add(base64.StdEncoding.EncodeToString([]byte(credential)))
	}
	add(b.DatasourceURL)
	if u, err := url.Parse(b.DatasourceURL); err == nil && u.Host != "" {
		add(u.Scheme + "://" + u.Host)
		add(u.Host)
	}
	return needleRedactor(ns...)
}

// needleRedactor redacts the given needles (empty ones are dropped), longest first.
func needleRedactor(needles ...string) redactor {
	ns := slices.DeleteFunc(slices.Clone(needles), func(s string) bool { return s == "" })
	slices.SortStableFunc(ns, func(a, b string) int { return cmp.Compare(len(b), len(a)) })
	pairs := make([]string, 0, 2*len(ns))
	for _, n := range ns {
		pairs = append(pairs, n, redactedText)
	}
	return redactor{needles: ns, rep: strings.NewReplacer(pairs...)}
}

// redact replaces each needle with <redacted> in one pass (leftmost, longest first). A string
// without a needle is returned as is, without allocating.
func (r redactor) redact(s string) string {
	for _, n := range r.needles {
		if strings.Contains(s, n) {
			return r.rep.Replace(s)
		}
	}
	return s
}

// cleanText makes an upstream text safe to show: every control byte (0x00-0x1F, 0x7F) becomes a
// space, and a text longer than max bytes is cut at a UTF-8 boundary with "…" appended.
func cleanText(s string, max int) string {
	clean := true
	for i := 0; i < len(s); i++ {
		if c := s[i]; c < 0x20 || c == 0x7f {
			clean = false
			break
		}
	}
	if !clean {
		b := []byte(s)
		for i, c := range b {
			if c < 0x20 || c == 0x7f {
				b[i] = ' '
			}
		}
		s = string(b)
	}
	if len(s) <= max {
		return s
	}
	return cutUTF8(s, max) + "…"
}

// cutData cuts a data string at 4 096 bytes (a UTF-8 boundary).
func cutData(s string) string {
	if len(s) <= maxDataString {
		return s
	}
	return cutUTF8(s, maxDataString)
}

func cutUTF8(s string, n int) string {
	for n > 0 && !utf8.RuneStart(s[n]) {
		n--
	}
	return s[:n]
}

// upstreamHeaders are the accepted response headers (§4.9). Each value is redacted; one that
// redaction changed or that fails its pattern is treated as absent.
type upstreamHeaders struct {
	QueryID            string
	ReadCache          string // hit | miss | bypass | other | "" (absent)
	ReadCacheThroughMs int64  // -1 when absent
	RetryAfter         string
}

var (
	queryIDPattern    = regexp.MustCompile(`^[A-Za-z0-9_-]{1,64}$`)
	throughPattern    = regexp.MustCompile(`^[0-9]{1,9}$`)
	retryAfterPattern = regexp.MustCompile(`^[0-9]{1,6}$`)
)

// accepted returns v if redaction leaves it unchanged and it matches p.
func accepted(v string, r redactor, p *regexp.Regexp) (string, bool) {
	if v == "" || r.redact(v) != v || !p.MatchString(v) {
		return "", false
	}
	return v, true
}

// readHeaders reads the allowlisted headers; nothing else of the response headers is read.
func readHeaders(h http.Header, r redactor) upstreamHeaders {
	out := upstreamHeaders{ReadCacheThroughMs: -1}
	out.QueryID, _ = accepted(h.Get("X-Pulsus-Query-Id"), r, queryIDPattern)
	if v := h.Get("X-Pulsus-Read-Cache"); v != "" {
		switch {
		case r.redact(v) != v:
			out.ReadCache = "other"
		case v == "hit" || v == "miss" || v == "bypass":
			out.ReadCache = v
		default:
			out.ReadCache = "other"
		}
	}
	if v, ok := accepted(h.Get("X-Pulsus-Read-Cache-Through"), r, throughPattern); ok {
		out.ReadCacheThroughMs, _ = strconv.ParseInt(v, 10, 64)
	}
	out.RetryAfter, _ = accepted(h.Get("Retry-After"), r, retryAfterPattern)
	return out
}
