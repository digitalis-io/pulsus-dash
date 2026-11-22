// Package pulsusfake is a PulsusDB stand-in that replays recorded transcripts and records what
// it received, including cancellation (plan #62 §4.7). Tests get it strict through fakeharness;
// cmd/pulsus-fake serves it for the dev stack with the generator on.
package pulsusfake

import (
	"context"
	"fmt"
	"io"
	"math"
	"net/http"
	"net/url"
	"strconv"
	"sync"
	"time"
)

// Options configure a Fake. Generate answers an unmatched /api/v1/query_range or /api/v1/query
// with one generated series instead of a 404 (dev stack only). MaxRecords > 0 keeps only the
// newest MaxRecords records: the oldest is dropped when one is added (plan #63 §3.6).
type Options struct {
	Generate   bool
	MaxRecords int
}

// Recorded is one request the fake received.
type Recorded struct {
	Transcript           string // "" when none matched, "generated" for the generator
	Method, Path         string
	Form                 url.Values
	Header               http.Header
	ReceivedAt           time.Time
	Cancelled, Completed bool
	CancelledAt          time.Time
}

// unexpectedBody answers a request no transcript matches.
const unexpectedBody = `{"status":"error","errorType":"not_found","error":"pulsus-fake: unexpected request"}`

// Fake serves transcripts. It is safe for concurrent use.
type Fake struct {
	ts      []Transcript
	o       Options
	mu      sync.Mutex
	recs    []*Recorded
	changed chan struct{} // closed and replaced on every record change
}

// New returns a fake serving ts.
func New(ts []Transcript, o Options) *Fake {
	return &Fake{ts: ts, o: o, changed: make(chan struct{})}
}

// ServeHTTP answers one request.
func (f *Fake) ServeHTTP(w http.ResponseWriter, r *http.Request) { f.Serve(w, r) }

// Serve answers one request and returns its record as it ended (cmd/pulsus-fake logs it).
func (f *Fake) Serve(w http.ResponseWriter, r *http.Request) Recorded {
	_ = r.ParseForm()
	rec := &Recorded{Method: r.Method, Path: r.URL.Path, Form: r.Form, Header: r.Header.Clone(), ReceivedAt: time.Now()}
	var t *Transcript
	for i := range f.ts {
		if f.ts[i].matches(r.Method, r.URL.Path, r.Form) && f.ts[i].Match.Query != nil {
			t = &f.ts[i]
			break
		}
	}
	if t == nil {
		for i := range f.ts {
			if f.ts[i].Match.Query == nil && f.ts[i].matches(r.Method, r.URL.Path, r.Form) {
				t = &f.ts[i]
				break
			}
		}
	}
	generate := t == nil && f.o.Generate && (r.URL.Path == "/api/v1/query_range" || r.URL.Path == "/api/v1/query")
	switch {
	case t != nil:
		rec.Transcript = t.Name
	case generate:
		rec.Transcript = "generated"
	}
	f.add(rec)
	switch {
	case t != nil:
		f.replay(w, r, rec, t.Response)
	case generate:
		f.generate(w, r, rec)
	default:
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusNotFound)
		_, _ = io.WriteString(w, unexpectedBody)
		f.update(rec, func(x *Recorded) { x.Completed = true })
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	return *rec
}

func (f *Fake) replay(w http.ResponseWriter, r *http.Request, rec *Recorded, resp Response) {
	if resp.Hang {
		<-r.Context().Done()
		f.cancelled(rec)
		return
	}
	if resp.DelayMs > 0 {
		t := time.NewTimer(time.Duration(resp.DelayMs) * time.Millisecond)
		defer t.Stop()
		select {
		case <-t.C:
		case <-r.Context().Done():
			f.cancelled(rec)
			return
		}
	}
	for k, v := range resp.Headers {
		w.Header().Set(k, v)
	}
	w.WriteHeader(resp.Status)
	if resp.BodyText != nil {
		_, _ = io.WriteString(w, *resp.BodyText)
	} else {
		_, _ = w.Write(resp.Body)
	}
	f.update(rec, func(x *Recorded) { x.Completed = true })
}

// generate answers one series {fake="generated"} with sin(t_s / 600) on the request's grid
// (query_range) or at its time (query).
func (f *Fake) generate(w http.ResponseWriter, r *http.Request, rec *Recorded) {
	num := func(k string, def float64) float64 {
		v, err := strconv.ParseFloat(r.Form.Get(k), 64)
		if err != nil {
			return def
		}
		return v
	}
	val := func(t float64) string { return strconv.FormatFloat(math.Sin(t/600), 'g', -1, 64) }
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("X-Pulsus-Query-Id", "fake-generated")
	var body string
	if r.URL.Path == "/api/v1/query" {
		at := num("time", float64(time.Now().Unix()))
		body = fmt.Sprintf(`{"status":"success","data":{"resultType":"vector","result":[{"metric":{"fake":"generated"},"value":[%s,%q]}]}}`,
			strconv.FormatFloat(at, 'f', -1, 64), val(at))
	} else {
		start, end, step := num("start", 0), num("end", 0), num("step", 15)
		if step <= 0 {
			step = 15
		}
		points := ""
		for i := 0; start+float64(i)*step <= end && i < 11001; i++ {
			t := start + float64(i)*step
			if i > 0 {
				points += ","
			}
			points += fmt.Sprintf("[%s,%q]", strconv.FormatFloat(t, 'f', -1, 64), val(t))
		}
		body = `{"status":"success","data":{"resultType":"matrix","result":[{"metric":{"fake":"generated"},"values":[` + points + `]}]}}`
	}
	w.WriteHeader(http.StatusOK)
	_, _ = io.WriteString(w, body)
	f.update(rec, func(x *Recorded) { x.Completed = true })
}

func (f *Fake) cancelled(rec *Recorded) {
	at := time.Now()
	f.update(rec, func(x *Recorded) { x.Cancelled, x.CancelledAt = true, at })
}

// add lists rec. A record dropped by MaxRecords is no longer listed; its request goroutine still
// updates its own *Recorded under f.mu.
func (f *Fake) add(rec *Recorded) {
	f.mu.Lock()
	f.recs = append(f.recs, rec)
	for f.o.MaxRecords > 0 && len(f.recs) > f.o.MaxRecords {
		f.recs[0] = nil
		f.recs = f.recs[1:]
	}
	f.notifyLocked()
	f.mu.Unlock()
}

func (f *Fake) update(rec *Recorded, fn func(*Recorded)) {
	f.mu.Lock()
	fn(rec)
	f.notifyLocked()
	f.mu.Unlock()
}

func (f *Fake) notifyLocked() {
	close(f.changed)
	f.changed = make(chan struct{})
}

// Requests returns a copy of the recorded requests, in arrival order.
func (f *Fake) Requests() []Recorded {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := make([]Recorded, 0, len(f.recs))
	for _, r := range f.recs {
		out = append(out, *r)
	}
	return out
}

// WaitCancelled waits until a request answered by transcript was cancelled, or ctx is done.
func (f *Fake) WaitCancelled(ctx context.Context, transcript string) (Recorded, error) {
	for {
		f.mu.Lock()
		for _, r := range f.recs {
			if r.Transcript == transcript && r.Cancelled {
				rec := *r
				f.mu.Unlock()
				return rec, nil
			}
		}
		ch := f.changed
		f.mu.Unlock()
		select {
		case <-ch:
		case <-ctx.Done():
			return Recorded{}, fmt.Errorf("pulsusfake: no cancelled %s request: %w", transcript, ctx.Err())
		}
	}
}

// Unexpected returns the requests no transcript matched (and the generator did not answer).
func (f *Fake) Unexpected() []Recorded {
	var out []Recorded
	for _, r := range f.Requests() {
		if r.Transcript == "" {
			out = append(out, r)
		}
	}
	return out
}

// Reset forgets the recorded requests; requests in flight still complete.
func (f *Fake) Reset() {
	f.mu.Lock()
	f.recs = nil
	f.notifyLocked()
	f.mu.Unlock()
}
