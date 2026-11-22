package pulsusdb

import (
	"io"
	"net/http"
	"reflect"
	"strings"
	"testing"
	"time"
)

// slotsHeld is the number of tenant slots the test binding holds.
func slotsHeld(c *Client) int {
	v, ok := c.limiter.slots.Load(testBindingID)
	if !ok {
		return 0
	}
	return len(v.(chan struct{}))
}

// matrixSeries is one test matrix series: labels and [seconds, value] points.
type matrixSeries struct {
	ls     []Label
	points [][2]string
}

func matrixJSON(o order, ss []matrixSeries) string {
	var objs []string
	for _, s := range ss {
		var ps []string
		for _, p := range s.points {
			ps = append(ps, "["+p[0]+","+jstr(p[1])+"]")
		}
		objs = append(objs, jobj(o, "metric", labelsJSON(o, s.ls), "values", "["+strings.Join(ps, ",")+"]"))
	}
	return "[" + strings.Join(objs, ",") + "]"
}

var twoSeries = []matrixSeries{
	{[]Label{{Name: "detected_level", Value: "info"}}, [][2]string{{"1767225600", "3"}, {"1767225605", "2"}}},
	{[]Label{{Name: "level", Value: "error"}}, [][2]string{{"1767229200", "4"}}},
}

// unit:log-member-order (§4.1).
func TestLogMemberOrder(t *testing.T) {
	t.Run("streams", func(t *testing.T) {
		var pages [2]*LogPage
		for i, o := range []order{typeFirst, resultFirst} {
			r, err := logsOf(t, streamsBody(o, a1Data()), Options{})
			if err != nil || r == nil || r.Page == nil {
				t.Fatalf("order %v: %+v %v", o, r, err)
			}
			pages[i] = r.Page
			if w := r.Page.Completeness.Warnings; !reflect.DeepEqual(w, []string{"w1"}) {
				t.Errorf("order %v: warnings %q, want [w1]", o, w)
			}
		}
		if !reflect.DeepEqual(pages[0], pages[1]) {
			t.Errorf("pages differ by member order:\n%+v\n%+v", pages[0], pages[1])
		}
		if len(pages[0].Entries) != 6 || pages[0].Next != nil || pages[0].Requests != 1 {
			t.Errorf("page %+v, want the six entries, no cursor, one request", pages[0])
		}
	})

	t.Run("matrix", func(t *testing.T) {
		var got [2][]*Series
		var comp [2]Completeness
		for i, o := range []order{typeFirst, resultFirst} {
			r, err := logsOf(t, body(o, "matrix", matrixJSON(o, twoSeries)), Options{})
			if err != nil || r == nil || r.Series == nil {
				t.Fatalf("order %v: %+v %v", o, r, err)
			}
			ss, err := drain(r.Series)
			if err != nil {
				t.Fatalf("order %v: %v", o, err)
			}
			got[i], comp[i] = ss, r.Series.Completeness()
			_ = r.Series.Close()
		}
		if len(got[0]) != 2 || !reflect.DeepEqual(got[0], got[1]) || !reflect.DeepEqual(comp[0], comp[1]) {
			t.Errorf("matrix differs by member order:\n%+v %+v\n%+v %+v", got[0], comp[0], got[1], comp[1])
		}
		var vol [2][]*Series
		for i, o := range []order{typeFirst, resultFirst} {
			u := newUpstream(t, answer(200, body(o, "matrix", matrixJSON(o, twoSeries))))
			ss, _, err := New(Options{}).LogVolume(ctxWithin(t, 5*time.Second), rcFor(testBinding(u.URL)), VolumeQuery{Query: `{app="x"}`, Grid: a1Grid()})
			if err != nil {
				t.Fatalf("volume order %v: %v", o, err)
			}
			vol[i] = ss
		}
		if len(vol[0]) != 2 || !reflect.DeepEqual(vol[0], vol[1]) {
			t.Errorf("volume differs by member order: %+v / %+v", vol[0], vol[1])
		}
	})

	t.Run("streaming kept", func(t *testing.T) {
		s1 := matrixJSON(typeFirst, twoSeries[:1])
		s1 = s1[1 : len(s1)-1]
		s2 := matrixJSON(typeFirst, twoSeries[1:])
		s2 = s2[1 : len(s2)-1]
		for _, o := range []order{typeFirst, resultFirst} {
			release := make(chan struct{})
			u := newUpstream(t, func(w http.ResponseWriter, _ *http.Request) {
				w.Header().Set("Content-Type", "application/json")
				head, tail := `{"status":"success","data":{"resultType":"matrix","result":[`+s1, `,`+s2+`]}}`
				if o == resultFirst {
					head, tail = `{"warnings":["w1"],"data":{"result":[`+s1, `,`+s2+`],"resultType":"matrix"},"status":"success"}`
				}
				_, _ = io.WriteString(w, head)
				w.(http.Flusher).Flush()
				<-release
				_, _ = io.WriteString(w, tail)
			})
			c := New(Options{})
			type first struct {
				s        *Series
				err      error
				slotFree bool
			}
			done := make(chan first, 1)
			go func() {
				r, err := c.LogQueryRange(ctxWithin(t, 10*time.Second), rcFor(testBinding(u.URL)), a1Query(10, Backward))
				if err != nil || r == nil || r.Series == nil {
					done <- first{err: err}
					return
				}
				free := slotsHeld(c) == 0
				s, err := r.Series.Next()
				done <- first{s, err, free}
				_, _ = drain(r.Series)
				_ = r.Series.Close()
			}()
			select {
			case f := <-done:
				if o == resultFirst {
					t.Errorf("result first: Next returned before the body ended: %+v", f)
				} else if f.err != nil || f.s == nil || f.s.Labels[0].Value != "info" {
					t.Errorf("type first: first series %+v", f)
				}
				close(release)
			case <-time.After(300 * time.Millisecond):
				close(release)
				f := <-done
				if o == typeFirst {
					t.Errorf("type first: Next did not return while the upstream was blocked")
				} else if f.err != nil || f.s == nil || !f.slotFree {
					t.Errorf("result first: %+v; want the first series with the slot already free", f)
				}
			}
		}
	})

	t.Run("protocol", func(t *testing.T) {
		for name, raw := range map[string]string{
			"result first, no resultType": `{"data":{"result":[]},"status":"success"}`,
			"result first, then vector":   `{"data":{"result":[],"resultType":"vector"},"status":"success"}`,
			"streams, then matrix":        `{"status":"success","data":{"resultType":"streams","result":[],"resultType":"matrix"}}`,
			"captured result not array":   `{"data":{"result":{"a":1},"resultType":"streams"},"status":"success"}`,
		} {
			_, err := logsOf(t, raw, Options{})
			wantProtocol(t, name, err)
		}
	})

	t.Run("capture bound", func(t *testing.T) {
		es := []tEntry{{t0 + 1, lsA, strings.Repeat("z", 2048)}}
		_, err := logsOf(t, streamsBody(resultFirst, es), Options{Limits: Limits{CaptureBytes: 1024}})
		if e, ok := err.(*Error); !ok || e.Kind != KindTooBroad ||
			e.Message != "the log response is larger than 96 MiB before its resultType; lower the limit or narrow the query" {
			t.Errorf("2 KiB captured over 1 KiB: %v, want KindTooBroad with the §4.1 message", err)
		}
		r, err := logsOf(t, streamsBody(typeFirst, es), Options{Limits: Limits{CaptureBytes: 1024}})
		if err != nil || r == nil || r.Page == nil || len(r.Page.Entries) != 1 {
			t.Errorf("type first under the same bound: %+v %v", r, err)
		}
	})

	t.Run("redaction", func(t *testing.T) {
		u := newUpstream(t, answer(200, streamsBody(resultFirst, []tEntry{
			{t0 + 1, []Label{{Name: "app", Value: "x"}, {Name: "token", Value: "a pw-secret-1 b"}}, "line pw-secret-1 end"}})))
		b := testBinding(u.URL)
		b.CredentialsRef = "env:C"
		c := New(Options{Secrets: secretsOf(map[string]string{"env:C": "user:pw-secret-1"})})
		r, err := c.LogQueryRange(ctxWithin(t, 5*time.Second), rcFor(b), a1Query(10, Backward))
		if err != nil || r == nil || r.Page == nil || len(r.Page.Entries) != 1 {
			t.Fatalf("redaction: %+v %v", r, err)
		}
		line, val := r.Page.Entries[0].Line, r.Page.Streams[0].Labels[1].Value
		for _, s := range []string{line, val} {
			if strings.Count(s, "<redacted>") != 1 || strings.Contains(s, "pw-secret-1") {
				t.Errorf("%q: want <redacted> exactly once and never the password", s)
			}
		}
	})
}
