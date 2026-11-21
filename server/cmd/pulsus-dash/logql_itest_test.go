//go:build itest

package main

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/digitalis-io/pulsus-dash/server/internal/keyhash"
	"github.com/digitalis-io/pulsus-dash/server/internal/pulsusfake"
	"github.com/digitalis-io/pulsus-dash/server/internal/pulsusfake/fakeharness"
	"github.com/digitalis-io/pulsus-dash/server/internal/store/storetest"
)

// The shared values of plan #65 A.1 and the log routes (Part B).
const (
	logRange  = "/api/dash/v1/query/logql/range?tenant=demo"
	logVolume = "/api/dash/v1/query/logql/volume?tenant=demo"
	a1T0      = int64(1767229100000000000)
	a1Lo      = "1767225600000000000"
	a1Hi      = "1767229200000000000"
)

type logEntry struct {
	TsNs     string            `json:"ts_ns"`
	Line     string            `json:"line"`
	Level    string            `json:"level"`
	Metadata map[string]string `json:"metadata"`
	Parsed   map[string]string `json:"parsed"`
}

type logPageResp struct {
	Kind      string `json:"kind"`
	Start     int64  `json:"start"`
	End       int64  `json:"end"`
	Step      int64  `json:"step"`
	Direction string `json:"direction"`
	Streams   []struct {
		Key     string            `json:"key"`
		Labels  map[string]string `json:"labels"`
		Entries []logEntry        `json:"entries"`
	} `json:"streams"`
	Cursor       *string        `json:"cursor"`
	Completeness map[string]any `json:"completeness"`
}

func decodeLogPage(t *testing.T, b []byte) logPageResp {
	t.Helper()
	dec := json.NewDecoder(bytes.NewReader(b))
	dec.DisallowUnknownFields()
	var p logPageResp
	if err := dec.Decode(&p); err != nil {
		t.Fatalf("page body %.400q: %v", b, err)
	}
	return p
}

// pagedEntry is one delivered entry: (ts, pod, line, level) and its stream key.
type pagedEntry struct {
	ts               int64
	pod, line, level string
	key              string
}

func (e pagedEntry) String() string { return e.line + "@" + strconv.FormatInt(e.ts-a1T0, 10) }

// pageOrder is the entries of p in page order (ts in direction, then the group order: stream key
// ascending, then line bytes); the body groups them by stream, streams in key order.
func pageOrder(t *testing.T, p logPageResp) []pagedEntry {
	t.Helper()
	var out []pagedEntry
	prevKey := ""
	for _, s := range p.Streams {
		if s.Key <= prevKey {
			t.Errorf("streams not in key order: %s after %s", s.Key, prevKey)
		}
		prevKey = s.Key
		for _, e := range s.Entries {
			ts, err := strconv.ParseInt(e.TsNs, 10, 64)
			if err != nil {
				t.Fatalf("ts_ns %q: %v", e.TsNs, err)
			}
			out = append(out, pagedEntry{ts: ts, pod: s.Labels["pod"], line: e.Line, level: e.Level, key: s.Key})
		}
	}
	slices.SortStableFunc(out, func(a, b pagedEntry) int {
		if a.ts != b.ts {
			if p.Direction == "forward" {
				return int(a.ts - b.ts)
			}
			return int(b.ts - a.ts)
		}
		if a.key != b.key {
			return strings.Compare(a.key, b.key)
		}
		return strings.Compare(a.line, b.line)
	})
	return out
}

func names(es []pagedEntry) []string {
	out := make([]string, len(es))
	for i, e := range es {
		out[i] = e.String()
	}
	return out
}

// waitRecorded waits, polling every 1 ms for at most 5 s, until the fake holds a record of
// transcript (plan #65 Part B §4.2: the BFF has written its whole upstream request).
func waitRecorded(t *testing.T, fake *pulsusfake.Fake, transcript string) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for {
		for _, r := range fake.Requests() {
			if r.Transcript == transcript {
				return
			}
		}
		if time.Now().After(deadline) {
			t.Fatalf("no %s request reached the fake", transcript)
		}
		time.Sleep(time.Millisecond)
	}
}

func logRangeBody(query, extra string) string { return rangeBody(query, extra) }

// itest:logql-streams (issue acceptance 1 as amended by Q5; T06-011, T06-006, T07-002, T04-004).
func TestLogqlStreamsItest(t *testing.T) {
	for _, c := range storetest.Clusters(t) {
		t.Run(c.Name, func(t *testing.T) {
			fake, url := fakeharness.Start(t)
			s, _ := boundServe(t, c, url, "  scope_org_id: acme\n")
			page := func(extra, cursor string) (logPageResp, []pulsusfake.Recorded) {
				t.Helper()
				fake.Reset()
				if cursor != "" {
					extra += `,"cursor":"` + cursor + `"`
				}
				code, b := s.send(t, logRange, logRangeBody(`{app="x"}`, extra))
				if code != 200 {
					t.Fatalf("page %s: %d %s", extra, code, b)
				}
				return decodeLogPage(t, b), fake.Requests()
			}
			var all = map[string][]pagedEntry{}
			check := func(dir string, p logPageResp, limit int) []pagedEntry {
				t.Helper()
				if p.Kind != "streams" || p.Start != 1767225600000 || p.End != 1767229200000 || p.Step != 5000 || p.Direction != dir {
					t.Errorf("%s page head %+v", dir, p)
				}
				es := pageOrder(t, p)
				if len(es) > limit {
					t.Errorf("%s page has %d entries, limit %d", dir, len(es), limit)
				}
				all[dir] = append(all[dir], es...)
				return es
			}
			form := func(r pulsusfake.Recorded, kv ...string) {
				t.Helper()
				for i := 0; i+1 < len(kv); i += 2 {
					if got := r.Form.Get(kv[i]); got != kv[i+1] {
						t.Errorf("upstream %s %s = %q, want %q", r.Transcript, kv[i], got, kv[i+1])
					}
				}
				if !regexp.MustCompile(`^[0-9]+ms$`).MatchString(r.Form.Get("timeout")) || r.Form.Get("query") != `{app="x"}` {
					t.Errorf("upstream %s timeout %q query %q", r.Transcript, r.Form.Get("timeout"), r.Form.Get("query"))
				}
				if r.Header.Get("X-Scope-OrgID") != "acme" {
					t.Errorf("upstream %s X-Scope-OrgID %q, want acme", r.Transcript, r.Header.Get("X-Scope-OrgID"))
				}
			}

			// Backward, limit 4: the upstream's partial group at 300 is not delivered.
			p, rs := page(`,"limit":4`, "")
			if es := check("backward", p, 4); !slices.Equal(names(es), []string{"a5@500", "b4@400"}) || p.Cursor == nil {
				t.Errorf("backward page 1 %v, cursor %v", names(es), p.Cursor)
			}
			if len(rs) != 1 {
				t.Fatalf("backward page 1: %d upstream requests", len(rs))
			}
			form(rs[0], "start", a1Lo, "end", a1Hi, "step", "5000ms", "limit", "5", "direction", "backward")
			p, rs = page(`,"limit":4`, *p.Cursor)
			es := check("backward", p, 4)
			if got := names(es); len(got) != 4 || p.Cursor != nil || strings.Count(strings.Join(got, " "), "a3@300") != 2 {
				t.Errorf("backward page 2 %v, cursor %v", got, p.Cursor)
			}
			if len(rs) != 1 {
				t.Fatalf("backward page 2: %d upstream requests", len(rs))
			}
			form(rs[0], "end", strconv.FormatInt(a1T0+300, 10), "limit", "5")

			// Forward, limit 2: three pages.
			p, rs = page(`,"limit":2,"direction":"forward"`, "")
			es = check("forward", p, 2)
			if len(rs) != 2 || rs[0].Transcript != "logs-page-forward-1" || rs[1].Transcript != "logs-group-300" || p.Cursor == nil || len(es) != 2 {
				t.Fatalf("forward page 1: %v, requests %d, cursor %v", names(es), len(rs), p.Cursor)
			}
			for _, r := range rs {
				form(r)
			}
			p, rs = page(`,"limit":2,"direction":"forward"`, *p.Cursor)
			es = check("forward", p, 2)
			if len(rs) != 1 || rs[0].Transcript != "logs-group-300" || p.Cursor == nil || len(es) != 2 {
				t.Fatalf("forward page 2: %v, requests %d, cursor %v", names(es), len(rs), p.Cursor)
			}
			form(rs[0])
			p, rs = page(`,"limit":2,"direction":"forward"`, *p.Cursor)
			if es := check("forward", p, 2); !slices.Equal(names(es), []string{"b4@400", "a5@500"}) || p.Cursor != nil || len(rs) != 1 {
				t.Errorf("forward page 3 %v, cursor %v, requests %d", names(es), p.Cursor, len(rs))
			} else {
				form(rs[0], "start", strconv.FormatInt(a1T0+300, 10), "limit", "3")
			}

			want := []string{"a3@300", "a3@300", "a5@500", "b3@300", "b4@400", "c3@300"}
			levels := map[string]string{"a": "info", "b": "warn", "c": "error"}
			for dir, es := range all {
				got := names(es)
				for i := 1; i < len(es); i++ {
					if (dir == "backward" && es[i].ts > es[i-1].ts) || (dir == "forward" && es[i].ts < es[i-1].ts) {
						t.Errorf("%s: ts not monotone across pages: %v", dir, got)
						break
					}
				}
				slices.Sort(got)
				if !slices.Equal(got, want) {
					t.Errorf("%s: delivered %v, want the 6 entries of A.1 %v", dir, got, want)
				}
				for _, e := range es {
					if e.level != levels[e.pod] {
						t.Errorf("%s: %s of pod %s has level %s, want %s", dir, e, e.pod, e.level, levels[e.pod])
					}
				}
			}

			code, b := s.send(t, logRange, logRangeBody(`{app="none"}`, ""))
			if p := decodeLogPage(t, b); code != 200 || len(p.Streams) != 0 || p.Streams == nil || p.Cursor != nil {
				t.Errorf("empty: %d %s", code, b)
			}
			s.stop(t)
		})
	}
}

// itest:logql-metric (issue acceptance 2; T06-011, T04-005).
func TestLogqlMetricItest(t *testing.T) {
	for _, c := range storetest.Clusters(t) {
		t.Run(c.Name, func(t *testing.T) {
			fake, url := fakeharness.Start(t)
			s, _ := boundServe(t, c, url, "")
			code, b := s.send(t, logRange, logRangeBody(`sum by (level) (count_over_time({app="x"}[1m]))`, ""))
			var r struct {
				Kind string `json:"kind"`
				rangeResp
			}
			if code == 200 {
				if err := json.Unmarshal(b, &r); err != nil {
					t.Fatal(err)
				}
				r.rangeResp = decodeRange(t, b)
			}
			if code != 200 || r.Kind != "series" || r.Step != 5000 || len(r.Frames) != 2 || bytes.Contains(b, []byte(`"cursor"`)) {
				t.Fatalf("metric: %d %.300s", code, b)
			}
			want := []struct {
				level string
				at    map[int]float64
			}{{"error", map[int]float64{0: 3, 1: 1}}, {"info", map[int]float64{0: 10, 720: 7}}}
			for i, w := range want {
				f := r.Frames[i]
				key := keyhash.Hex(keyhash.Labels([]keyhash.Label{{Name: "level", Value: w.level}}))
				if f.Key != key || len(f.Labels) != 1 || f.Labels["level"] != w.level || len(f.Timestamps) != 721 {
					t.Errorf("frame %d: key %s labels %v, %d timestamps", i, f.Key, f.Labels, len(f.Timestamps))
					continue
				}
				for j, ts := range f.Timestamps {
					if ts != 1767225600000+int64(j)*5000 {
						t.Fatalf("frame %d timestamp %d = %d", i, j, ts)
					}
					v, present := frameValue(t, f.Values[j])
					wv, ok := w.at[j]
					if present != ok || (ok && v != wv) {
						t.Errorf("frame %d point %d = %v %v, want %v %v", i, j, v, present, wv, ok)
					}
				}
			}
			rs := fake.Requests()
			if len(rs) != 1 || rs[0].Form.Get("limit") != "1001" || rs[0].Form.Get("direction") != "backward" {
				t.Errorf("upstream %+v", rs)
			}
			s.stop(t)
		})
	}
}

// itest:logql-volume (issue acceptance 3).
func TestLogqlVolumeItest(t *testing.T) {
	for _, c := range storetest.Clusters(t) {
		t.Run(c.Name, func(t *testing.T) {
			fake, url := fakeharness.Start(t)
			s, _ := boundServe(t, c, url, "")
			code, b := s.send(t, logVolume, logRangeBody(`{app="x"}`, ""))
			if code != 200 {
				t.Fatalf("volume: %d %s", code, b)
			}
			r := decodeRange(t, b)
			want := []struct {
				level string
				at    map[int]float64
			}{
				{"error", map[int]float64{0: 5}},
				{"warn", map[int]float64{0: 1, 720: 4}},
				{"info", map[int]float64{0: 5, 1: 2}},
				{"debug", map[int]float64{0: 6}},
				{"unknown", map[int]float64{1: 7}},
			}
			if r.Start != 1767225600000 || r.End != 1767229200000 || r.Step != 5000 || len(r.Frames) != len(want) {
				t.Fatalf("volume head %d %d %d, %d frames", r.Start, r.End, r.Step, len(r.Frames))
			}
			for i, w := range want {
				f := r.Frames[i]
				if f.Key != keyhash.Hex(keyhash.Labels([]keyhash.Label{{Name: "level", Value: w.level}})) || len(f.Labels) != 1 || f.Labels["level"] != w.level {
					t.Errorf("frame %d: key %s labels %v, want level %s", i, f.Key, f.Labels, w.level)
					continue
				}
				for j := range f.Values {
					v, present := frameValue(t, f.Values[j])
					wv, ok := w.at[j]
					if present != ok || (ok && v != wv) {
						t.Errorf("%s point %d = %v %v, want %v %v", w.level, j, v, present, wv, ok)
					}
				}
			}
			rs := fake.Requests()
			const composed = "sum by (level, detected_level) (count_over_time({app=\"x\"}\n| drop __error__ [5s]))"
			if len(rs) != 1 || rs[0].Form.Get("query") != composed || rs[0].Form.Get("step") != "5000ms" {
				t.Errorf("upstream %+v", rs)
			}
			s.stop(t)
		})
	}
}

// itest:logql-errors (issue acceptance 4; PRF-031, T06-009, T06-010, T07-020, T09-009, T06-026).
func TestLogqlErrorsItest(t *testing.T) {
	for _, c := range storetest.Clusters(t) {
		t.Run(c.Name, func(t *testing.T) {
			fake, url := fakeharness.Start(t)
			s, _ := boundServe(t, c, url, "")
			pos := func(e map[string]any) any {
				h, _ := e["hint"].(map[string]any)
				p, _ := h["position"].(map[string]any)
				return p["offset"]
			}
			pointer := func(e map[string]any) (string, string) {
				fs, _ := e["fields"].([]any)
				if len(fs) != 1 {
					return "", ""
				}
				f := fs[0].(map[string]any)
				return f["pointer"].(string), f["message_key"].(string)
			}
			hintOf := func(e map[string]any, k string) any {
				h, _ := e["hint"].(map[string]any)
				return h[k]
			}

			code, b := s.send(t, logRange, logRangeBody(`{app="x"`, ""))
			e := errorOf(t, b)
			if p, k := pointer(e); code != 400 || e["code"] != "invalid" || p != "/query" || k != "query.invalid" || pos(e) != float64(8) ||
				e["message"] != "unexpected end of query at byte 8: expected '}'" || e["query_id"] != "fake-logs-parse-error-1" {
				t.Errorf("parse error: %d %s", code, b)
			}
			code, b = s.send(t, logRange, logRangeBody(`{app="x"} | line_format "{{"`, ""))
			if e := errorOf(t, b); code != 400 || e["hint"] != nil || e["message"] != "invalid line template: template: line:1: unclosed action" {
				t.Errorf("no position: %d %s", code, b)
			}
			code, b = s.send(t, logRange, logRangeBody(`{app=~".+"}`, ""))
			if e := errorOf(t, b); code != 422 || e["code"] != "too_broad" || hintOf(e, "action") != "narrow" || e["query_id"] != "fake-logs-too-broad-1" ||
				e["message"] != "query too broad: resolved 100001 streams, exceeding the 100000-stream cap" {
				t.Errorf("too broad: %d %s", code, b)
			}
			code, b = s.send(t, logRange, `{"query":"{app=\"wide\"}","from":1577836800000,"to":1767225600000,"width_px":1200}`)
			if e := errorOf(t, b); code != 400 || e["code"] != "invalid" || e["hint"] != nil ||
				e["message"] != "query time range of 189388800000000000 ns is outside the supported range (0 to 157680000000000000 ns)" {
				t.Errorf("wide window: %d %s", code, b)
			}
			code, b = s.send(t, logRange, logRangeBody(`{app="slow"}`, ""))
			if e := errorOf(t, b); code != 504 || e["code"] != "unavailable" || hintOf(e, "reason") != "upstream_timeout" {
				t.Errorf("timeout: %d %s", code, b)
			}
			start := time.Now()
			code, b = s.send(t, logRange, logRangeBody(`{app="hang"}`, `,"timeout_ms":300`))
			if code != 504 || time.Since(start) > time.Second {
				t.Errorf("hang: %d after %v: %s", code, time.Since(start), b)
			}
			ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
			if rec, err := fake.WaitCancelled(ctx, "logs-hang"); err != nil || !rec.Cancelled {
				t.Errorf("hang: the fake did not record the cancel: %v", err)
			}
			cancel()
			code, b = s.send(t, logVolume, logRangeBody(`{app="x"`, ""))
			if e := errorOf(t, b); code != 400 || pos(e) != float64(8) || e["message"] != "unexpected '|' at byte 8: expected '}'" {
				t.Errorf("volume parse error: %d %s", code, b)
			}

			// Refused before any request.
			code, b = s.send(t, logRange, logRangeBody(`{app="x"}`, `,"limit":4`))
			cursor := decodeLogPage(t, b).Cursor
			if code != 200 || cursor == nil {
				t.Fatalf("page 1: %d %s", code, b)
			}
			fake.Reset()
			v2 := "Ag" + (*cursor)[2:] // the first byte 0x02: version 2
			for _, r := range []struct {
				name, path, body, pointer, key string
			}{
				{"timeout_ms 199", logRange, logRangeBody(`{app="x"}`, `,"timeout_ms":199`), "/timeout_ms", "field.range"},
				{"limit 5001", logRange, logRangeBody(`{app="x"}`, `,"limit":5001`), "/limit", "field.range"},
				{"to beyond", logRange, `{"query":"{app=\"x\"}","from":1,"to":9223372036855,"width_px":3}`, "/to", "field.range"},
				{"cursor !", logRange, logRangeBody(`{app="x"}`, `,"cursor":"!"`), "/cursor", "field.range"},
				{"cursor version 2", logRange, logRangeBody(`{app="x"}`, `,"limit":4,"cursor":"`+v2+`"`), "/cursor", "cursor.invalid"},
				{"cursor of the other direction", logRange, logRangeBody(`{app="x"}`, `,"limit":4,"direction":"forward","cursor":"`+*cursor+`"`), "/cursor", "cursor.mismatch"},
			} {
				code, b := s.send(t, r.path, r.body)
				if p, k := pointer(errorOf(t, b)); code != 400 || p != r.pointer || k != r.key {
					t.Errorf("%s: %d %s", r.name, code, b)
				}
			}
			code, b = s.send(t, logRange, logRangeBody(`{source="pulsus-dash"}`, ""))
			if e := errorOf(t, b); code != 400 || e["code"] != "virtual_unsupported" || hintOf(e, "reserved") != `source="pulsus-dash"` {
				t.Errorf("reserved: %d %s", code, b)
			}
			if code, m := s.get(t, "/api/dash/v1/logs/series?tenant=demo&from=0&to=1"); code != 400 {
				t.Errorf("series without match: %d %v", code, m)
			} else if fs, _ := m["error"].(map[string]any)["fields"].([]any); len(fs) != 1 ||
				fs[0].(map[string]any)["pointer"] != "/match" || fs[0].(map[string]any)["message_key"] != "field.required" {
				t.Errorf("series without match: %v", m)
			}
			if n := len(fake.Requests()); n != 0 {
				t.Errorf("%d upstream requests for refused requests", n)
			}
			s.stop(t)

			closed, _ := boundServe(t, c, closedURL(t), "")
			code, b = closed.send(t, logRange, logRangeBody(`{app="x"}`, ""))
			if e := errorOf(t, b); code != 502 || hintOf(e, "reason") != "upstream_unreachable" {
				t.Errorf("closed port: %d %s", code, b)
			}
			if code, m := closed.get(t, "/readyz"); code != 200 || m["status"] != "ready" {
				t.Errorf("/readyz %d %v", code, m)
			}
			closed.stop(t)
		})
	}
}

// itest:logql-cancel (PRF-030, T04-013, T06-010): a browser cancel drops the upstream request
// within 50 ms, on the first request of a page (a) and on its group fetch (b).
func TestLogqlCancelItest(t *testing.T) {
	for _, c := range storetest.Clusters(t) {
		t.Run(c.Name, func(t *testing.T) {
			for _, k := range []struct {
				name, query, extra, transcript string
				requests                       int
			}{
				{"a_first_request", `{app="hang"}`, "", "logs-hang", 1},
				{"b_group_fetch", `{app="hang2"}`, `,"limit":1`, "logs-hang-group", 2},
			} {
				t.Run(k.name, func(t *testing.T) {
					fake, url := fakeharness.Start(t)
					s, _ := boundServe(t, c, url, "")
					ctx, cancel := context.WithCancel(context.Background())
					defer cancel()
					req, _ := http.NewRequestWithContext(ctx, http.MethodPost, "http://"+s.addr+logRange, strings.NewReader(logRangeBody(k.query, k.extra)))
					done := make(chan struct{})
					go func() {
						defer close(done)
						if resp, err := http.DefaultClient.Do(req); err == nil {
							_ = resp.Body.Close()
						}
					}()
					waitRecorded(t, fake, k.transcript)
					t0 := time.Now()
					cancel()
					wctx, wcancel := context.WithTimeout(context.Background(), 2*time.Second)
					defer wcancel()
					rec, err := fake.WaitCancelled(wctx, k.transcript)
					if err != nil {
						t.Fatalf("WaitCancelled: %v", err)
					}
					if d := rec.CancelledAt.Sub(t0); d > 50*time.Millisecond {
						t.Errorf("upstream cancelled %v after the browser, want ≤ 50 ms", d)
					} else {
						t.Logf("upstream cancelled %v after the browser", d)
					}
					<-done
					if n := len(fake.Requests()); n != k.requests {
						t.Errorf("%d upstream requests, want %d (no request starts after the cancel)", n, k.requests)
					}
					if st := accessStatus(t, s, "/api/dash/v1/query/logql/range"); st != 499 {
						t.Errorf("access log status %v, want 499", st)
					}
					s.stop(t)
				})
			}
		})
	}
}
