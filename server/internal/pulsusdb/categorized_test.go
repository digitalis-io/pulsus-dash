package pulsusdb

import (
	"net/http"
	"slices"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// unit:log-level (owner decision 2026-11-21): stream labels, then structured metadata, then
// parsed fields; within each, detected_level before level.
func TestEntryLevel(t *testing.T) {
	for _, c := range []struct {
		stream, meta, parsed []Label
		want                 Level
	}{
		{lbl("detected_level", "debug"), lbl("detected_level", "error"), lbl("level", "warn"), LevelDebug},
		{lbl("level", "info"), lbl("detected_level", "error"), nil, LevelInfo},
		{lbl("app", "x"), lbl("detected_level", "error", "level", "warn"), lbl("level", "info"), LevelError},
		{lbl("app", "x"), lbl("level", "WARNING"), lbl("detected_level", "info"), LevelWarn},
		{lbl("app", "x"), lbl("detected_level", "unknown"), lbl("detected_level", "fatal"), LevelCritical},
		{lbl("detected_level", "nonsense"), nil, lbl("level", "trace"), LevelTrace},
		{lbl("app", "x"), nil, lbl("detected_level", "nonsense", "level", "err"), LevelError},
		{lbl("app", "x"), lbl("trace_id", "a"), lbl("first", "b"), LevelUnknown},
		{nil, nil, nil, LevelUnknown},
	} {
		if got := EntryLevel(c.stream, c.meta, c.parsed); got != c.want {
			t.Errorf("EntryLevel(%v, %v, %v) = %v, want %v", c.stream, c.meta, c.parsed, got, c.want)
		}
	}
}

// categorisedDoc is a categorised streams response with the values of one stream {app="x"}.
func categorisedDoc(values string) string {
	return `{"status":"success","data":{"resultType":"streams","encodingFlags":["categorize-labels"],"result":[{"stream":{"app":"x"},"values":[` + values + `]}]}}`
}

// unit:log-categorized (owner decision 2026-11-21): the header on page requests only; the
// categorised and the plain shape decoded; metadata and parsed fields bounded and redacted.
func TestLogCategorized(t *testing.T) {
	// The header is sent on every page request (main fetch and group fetch), on no other call.
	g := []tEntry{{t0 + 300, lsA, "a"}, {t0 + 300, lsA, "b"}}
	u := logUpstream(t, scripted(g))
	c := New(Options{})
	if _, err := c.LogQueryRange(ctxWithin(t, 5*time.Second), rcFor(testBinding(u.URL)), a1Query(1, Backward)); err != nil {
		t.Fatal(err)
	}
	rs := u.requests()
	if len(rs) < 2 {
		t.Fatalf("%d requests, want a main fetch and a group fetch", len(rs))
	}
	for i, r := range rs {
		if v := r.Header.Values("X-Loki-Response-Encoding-Flags"); !slices.Equal(v, []string{"categorize-labels"}) {
			t.Errorf("page request %d: encoding flags %q, want categorize-labels", i+1, v)
		}
	}
	uv := newUpstream(t, answer(200, body(typeFirst, "matrix", "[]")))
	_, _, _ = c.LogVolume(ctxWithin(t, 5*time.Second), rcFor(testBinding(uv.URL)), VolumeQuery{Query: volumeText(`{app="x"}`), Grid: a1Grid()})
	ul := newUpstream(t, answer(200, `{"status":"success","data":[]}`))
	_, _ = c.LogLabels(ctxWithin(t, 5*time.Second), rcFor(testBinding(ul.URL)), LogMatchQuery{})
	for name, us := range map[string]*upstream{"volume": uv, "labels": ul} {
		for _, r := range us.requests() {
			if v := r.Header.Get("X-Loki-Response-Encoding-Flags"); v != "" {
				t.Errorf("%s: encoding flags %q, want none", name, v)
			}
		}
	}

	// The categorised shape.
	r, err := logsOf(t, categorisedDoc(
		`[`+ts(3)+`,"l3",{"structuredMetadata":{"trace_id":"abc","detected_level":"warn"},"parsed":{"level":"error","first":"x"}}],`+
			`[`+ts(2)+`,"l2",{"parsed":{"level":"ERR"}}],`+
			`[`+ts(1)+`,"l1",{}]`), Options{})
	if err != nil || r == nil || r.Page == nil || len(r.Page.Entries) != 3 {
		t.Fatalf("categorised: %+v %v", r, err)
	}
	es := r.Page.Entries
	if !slices.Equal(es[0].Metadata, lbl("detected_level", "warn", "trace_id", "abc")) || !slices.Equal(es[0].Parsed, lbl("first", "x", "level", "error")) || es[0].Level != LevelWarn {
		t.Errorf("entry l3: metadata %v parsed %v level %v", es[0].Metadata, es[0].Parsed, es[0].Level)
	}
	if es[1].Metadata != nil || !slices.Equal(es[1].Parsed, lbl("level", "ERR")) || es[1].Level != LevelError {
		t.Errorf("entry l2: metadata %v parsed %v level %v", es[1].Metadata, es[1].Parsed, es[1].Level)
	}
	if es[2].Metadata != nil || es[2].Parsed != nil || es[2].Level != LevelUnknown {
		t.Errorf("entry l1: metadata %v parsed %v level %v", es[2].Metadata, es[2].Parsed, es[2].Level)
	}
	if s := r.Page.Streams; len(s) != 1 || !slices.Equal(s[0].Labels, lbl("app", "x")) || s[0].Level != LevelUnknown {
		t.Errorf("streams %+v, want {app=x} with level unknown", s)
	}

	// The plain shape: the level comes from the stream labels; an unrecognised third element
	// is skipped.
	r, err = logsOf(t, `{"status":"success","data":{"resultType":"streams","result":[{"stream":{"app":"x","detected_level":"info"},"values":[[`+
		ts(2)+`,"p2"],[`+ts(1)+`,"p1",{"k":"v"}]]}]}}`, Options{})
	if err != nil || r == nil || r.Page == nil || len(r.Page.Entries) != 2 {
		t.Fatalf("plain: %+v %v", r, err)
	}
	for _, e := range r.Page.Entries {
		if e.Metadata != nil || e.Parsed != nil || e.Level != LevelInfo {
			t.Errorf("plain %s: metadata %v parsed %v level %v, want none, none, info", e.Line, e.Metadata, e.Parsed, e.Level)
		}
	}

	// A stream label's level wins over metadata.
	r, err = logsOf(t, `{"status":"success","data":{"resultType":"streams","result":[{"stream":{"app":"x","level":"debug"},"values":[[`+
		ts(1)+`,"m",{"structuredMetadata":{"detected_level":"error"}}]]}]}}`, Options{})
	if err != nil || r.Page == nil || len(r.Page.Entries) != 1 || r.Page.Entries[0].Level != LevelDebug {
		t.Errorf("stream level first: %+v %v", r, err)
	}

	// Malformed categorised members are refused.
	for name, v := range map[string]string{
		"metadata value a number": `[` + ts(1) + `,"l",{"structuredMetadata":{"a":1}}]`,
		"parsed an array":         `[` + ts(1) + `,"l",{"parsed":["a"]}]`,
	} {
		_, err := logsOf(t, categorisedDoc(v), Options{})
		wantProtocol(t, name, err)
	}

	// Names and values are cut at 4 096 bytes and count towards PageBytes.
	long := strings.Repeat("v", 5000)
	r, err = logsOf(t, categorisedDoc(`[`+ts(1)+`,"l",{"structuredMetadata":{"k":"`+long+`"},"parsed":{"`+long+`":"p"}}]`), Options{})
	if err != nil || r.Page == nil || len(r.Page.Entries) != 1 {
		t.Fatalf("long: %+v %v", r, err)
	}
	if e := r.Page.Entries[0]; len(e.Metadata) != 1 || len(e.Metadata[0].Value) != 4096 || len(e.Parsed) != 1 || len(e.Parsed[0].Name) != 4096 {
		t.Errorf("long metadata/parsed not cut at 4096: %d %d", len(e.Metadata), len(e.Parsed))
	}
	_, err = logsOf(t, categorisedDoc(`[`+ts(1)+`,"l",{"structuredMetadata":{"k":"`+strings.Repeat("m", 200)+`"}}]`), Options{Limits: Limits{PageBytes: 100}})
	if kindOf(err) != KindTooBroad {
		t.Errorf("metadata over PageBytes: %v, want KindTooBroad", err)
	}

	// Entries equal but for their metadata come in one order whatever the upstream's.
	var orders [][]string
	for _, vs := range []string{
		`[` + ts(1) + `,"same",{"structuredMetadata":{"k":"b"}}],[` + ts(1) + `,"same",{"structuredMetadata":{"k":"a"}}]`,
		`[` + ts(1) + `,"same",{"structuredMetadata":{"k":"a"}}],[` + ts(1) + `,"same",{"structuredMetadata":{"k":"b"}}]`,
	} {
		r, err := logsOf(t, categorisedDoc(vs), Options{})
		if err != nil || r.Page == nil || len(r.Page.Entries) != 2 {
			t.Fatalf("order: %+v %v", r, err)
		}
		var o []string
		for _, e := range r.Page.Entries {
			if len(e.Metadata) == 1 {
				o = append(o, e.Metadata[0].Value)
			}
		}
		orders = append(orders, o)
	}
	if !slices.Equal(orders[0], []string{"a", "b"}) || !slices.Equal(orders[1], []string{"a", "b"}) {
		t.Errorf("orders %v, want [a b] twice", orders)
	}

	// Metadata and parsed values are redacted like lines.
	var base atomic.Value
	ur := newUpstream(t, func(w http.ResponseWriter, r *http.Request) {
		answer(200, categorisedDoc(`[`+ts(1)+`,"l",{"structuredMetadata":{"u":`+jstr(base.Load().(string))+`},"parsed":{"pw":"pw-secret-1"}}]`))(w, r)
	})
	base.Store(ur.URL)
	b := testBinding(ur.URL)
	b.CredentialsRef = "env:C"
	cr := New(Options{Secrets: secretsOf(map[string]string{"env:C": "user:pw-secret-1"})})
	res, err := cr.LogQueryRange(ctxWithin(t, 5*time.Second), rcFor(b), a1Query(10, Backward))
	if err != nil || res.Page == nil || len(res.Page.Entries) != 1 {
		t.Fatalf("redaction: %+v %v", res, err)
	}
	if e := res.Page.Entries[0]; len(e.Metadata) != 1 || e.Metadata[0].Value != "<redacted>" || len(e.Parsed) != 1 || e.Parsed[0].Value != "<redacted>" {
		t.Errorf("redaction: metadata %v parsed %v", e.Metadata, e.Parsed)
	}
}

// unit:log-categorized: the page bound is enforced pair by pair inside one metadata or parsed
// map, so the decode stops at the pair that crosses it and never reads the rest of the map.
func TestLogCategorizedBound(t *testing.T) {
	for _, member := range []string{"structuredMetadata", "parsed"} {
		var pairs []string
		for i := range 20 {
			pairs = append(pairs, `"k`+strconv.Itoa(i)+`":"`+strings.Repeat("v", 20)+`"`)
		}
		// Past the bound the map turns malformed: a decoder that reads the whole map first
		// reports a protocol error instead of stopping at the bound.
		pairs = append(pairs, `"bad":1`)
		raw := categorisedDoc(`[` + ts(1) + `,"l",{"` + member + `":{` + strings.Join(pairs, ",") + `}}]`)
		_, err := logsOf(t, raw, Options{Limits: Limits{PageBytes: 100}})
		if kindOf(err) != KindTooBroad {
			t.Errorf("%s over PageBytes 100: %v, want KindTooBroad at the crossing pair", member, err)
		}
	}
}

// unit:log-decode: stream labels are counted against the page bound pair by pair, so one
// oversized stream-label map stops the decode at the crossing pair and the rest is never read.
func TestLogStreamLabelsBound(t *testing.T) {
	var pairs []string
	for i := range 20 {
		pairs = append(pairs, `"k`+strconv.Itoa(i)+`":"`+strings.Repeat("v", 20)+`"`)
	}
	pairs = append(pairs, `"bad":1`) // malformed past the bound
	raw := `{"status":"success","data":{"resultType":"streams","result":[{"stream":{` + strings.Join(pairs, ",") +
		`},"values":[[` + ts(1) + `,"l"]]}]}}`
	_, err := logsOf(t, raw, Options{Limits: Limits{PageBytes: 100}})
	if kindOf(err) != KindTooBroad {
		t.Errorf("stream labels over PageBytes 100: %v, want KindTooBroad at the crossing pair", err)
	}
}

// unit:log-categorized: entries equal but for their parsed fields are sub-paged in one order,
// each exactly once, while the upstream reorders the group on every request.
func TestLogParsedTieBreak(t *testing.T) {
	e := func(v string) string { return `[` + ts(1) + `,"same",{"parsed":{"k":"` + v + `"}}]` }
	answers := []string{
		e("c") + "," + e("b"),                // main fetch (limit 2): the edge group fills it
		e("c") + "," + e("b") + "," + e("a"), // group fetch, page 1
		e("a") + "," + e("c") + "," + e("b"), // group fetch, page 2
		e("b") + "," + e("a") + "," + e("c"), // group fetch, page 3
	}
	var n atomic.Int64
	u := newUpstream(t, func(w http.ResponseWriter, r *http.Request) {
		i := int(n.Add(1) - 1)
		vs := ""
		if i < len(answers) {
			vs = answers[i]
		}
		answer(200, categorisedDoc(vs))(w, r)
	})
	c := New(Options{})
	q := a1Query(1, Backward)
	var got []string
	for range 10 {
		r, err := c.LogQueryRange(ctxWithin(t, 5*time.Second), rcFor(testBinding(u.URL)), q)
		if err != nil || r.Page == nil {
			t.Fatalf("page: %+v %v", r, err)
		}
		for _, e := range r.Page.Entries {
			got = append(got, e.Parsed[0].Value)
		}
		if r.Page.Next == nil {
			break
		}
		q.After = r.Page.Next
	}
	if !slices.Equal(got, []string{"a", "b", "c"}) {
		t.Errorf("delivered %v, want a b c, each once", got)
	}
}
