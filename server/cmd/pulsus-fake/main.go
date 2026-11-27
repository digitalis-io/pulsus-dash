// Command pulsus-fake serves the PulsusDB transcripts of internal/pulsusfake for the dev stack
// (plan #62 §4.7): pulsus-fake [--listen ADDR] [--transcripts DIR] [--generate=true|false]
// [--control]. --control serves GET /__fake/requests and POST /__fake/reset for the e2e rig and
// keeps the newest 1 000 records (plan #63 §3.6).
package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/digitalis-io/pulsus-dash/server/internal/pulsusfake"
)

func main() {
	os.Exit(run(os.Args[1:]))
}

func run(args []string) int {
	fs := flag.NewFlagSet("pulsus-fake", flag.ContinueOnError)
	listen := fs.String("listen", "localhost:9091", "address to listen on")
	dir := fs.String("transcripts", "", "directory of *.json transcripts (default: the embedded set)")
	generate := fs.Bool("generate", true, "answer unmatched range and instant queries with a generated series")
	control := fs.Bool("control", false, "serve /__fake/requests and /__fake/reset; keep records")
	clip := fs.Bool("clip-grid", false, "answer a range transcript's matrix with only its samples on the request's grid")
	if err := fs.Parse(args); err != nil {
		return 2
	}
	ts := pulsusfake.Default()
	if *dir != "" {
		var err error
		if ts, err = pulsusfake.Load(os.DirFS(*dir)); err != nil {
			fmt.Fprintln(os.Stderr, err)
			return 2
		}
	}
	o := pulsusfake.Options{Generate: *generate, ClipToGrid: *clip}
	if *control {
		o.MaxRecords = controlRecords
	}
	f := pulsusfake.New(ts, o)
	h := newHandler(f, *control, os.Stdout)
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	var lc net.ListenConfig
	ln, err := lc.Listen(ctx, "tcp", *listen)
	if err != nil {
		fmt.Fprintln(os.Stderr, "pulsus-fake: listen:", err)
		return 1
	}
	srv := &http.Server{Handler: h, ReadHeaderTimeout: 10 * time.Second}
	done := make(chan error, 1)
	go func() { done <- srv.Serve(ln) }()
	fmt.Fprintf(os.Stderr, "pulsus-fake: listening on %s with %d transcripts\n", ln.Addr(), len(ts))
	select {
	case <-ctx.Done():
	case err := <-done:
		fmt.Fprintln(os.Stderr, "pulsus-fake:", err)
		return 1
	}
	sctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := srv.Shutdown(sctx); err != nil && !errors.Is(err, http.ErrServerClosed) {
		fmt.Fprintln(os.Stderr, "pulsus-fake: shutdown:", err)
		return 1
	}
	return 0
}

// controlRecords bounds the records a --control fake keeps (the oldest are dropped).
const controlRecords = 1000

// requestSummary is one record as GET /__fake/requests lists it (plan #63 §3.6).
type requestSummary struct {
	Transcript   string `json:"transcript"`
	Method       string `json:"method"`
	Path         string `json:"path"`
	Query        string `json:"query"` // Form.Get("query"): "" when absent
	Start        string `json:"start"`
	End          string `json:"end"`
	Step         string `json:"step"`
	Time         string `json:"time"`
	State        string `json:"state"` // "inflight", "completed" or "cancelled"
	ReceivedAtMs int64  `json:"receivedAtMs"`
}

func summarise(r pulsusfake.Recorded) requestSummary {
	state := "inflight"
	switch {
	case r.Cancelled:
		state = "cancelled"
	case r.Completed:
		state = "completed"
	}
	return requestSummary{
		Transcript: r.Transcript, Method: r.Method, Path: r.Path,
		Query: r.Form.Get("query"), Start: r.Form.Get("start"), End: r.Form.Get("end"),
		Step: r.Form.Get("step"), Time: r.Form.Get("time"),
		State: state, ReceivedAtMs: r.ReceivedAt.UnixMilli(),
	}
}

const unknownControlRoute = `{"error":"pulsus-fake: unknown control route"}`

// newHandler is run's handler. control=false: every request is served and logged, then the
// records are reset (the dev fake keeps no history). control=true: /__fake/* is answered by the
// control routes and not recorded; every other request is served and logged, and its record stays
// listed from arrival (bounded by the fake's MaxRecords).
func newHandler(f *pulsusfake.Fake, control bool, log io.Writer) http.Handler {
	enc := json.NewEncoder(log)
	var mu sync.Mutex // one log line at a time
	serve := func(w http.ResponseWriter, r *http.Request) {
		sw := &statusWriter{ResponseWriter: w}
		rec := f.Serve(sw, r)
		mu.Lock()
		_ = enc.Encode(map[string]any{"method": rec.Method, "path": rec.Path, "transcript": rec.Transcript,
			"status": sw.status, "cancelled": rec.Cancelled})
		mu.Unlock()
	}
	if !control {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			serve(w, r)
			f.Reset() // the dev fake keeps no history: memory stays bounded
		})
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.URL.Path == "/__fake/requests":
			if r.Method != http.MethodGet {
				w.Header().Set("Allow", http.MethodGet)
				w.WriteHeader(http.StatusMethodNotAllowed)
				return
			}
			recs := f.Requests()
			out := make([]requestSummary, 0, len(recs))
			for _, rec := range recs {
				out = append(out, summarise(rec))
			}
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(out)
		case r.URL.Path == "/__fake/reset":
			if r.Method != http.MethodPost {
				w.Header().Set("Allow", http.MethodPost)
				w.WriteHeader(http.StatusMethodNotAllowed)
				return
			}
			f.Reset()
			w.WriteHeader(http.StatusNoContent)
		case strings.HasPrefix(r.URL.Path, "/__fake/"):
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusNotFound)
			_, _ = io.WriteString(w, unknownControlRoute)
		default:
			serve(w, r)
		}
	})
}

// statusWriter records the status for the log line.
type statusWriter struct {
	http.ResponseWriter
	status int
}

func (s *statusWriter) WriteHeader(code int) {
	if s.status == 0 {
		s.status = code
	}
	s.ResponseWriter.WriteHeader(code)
}

func (s *statusWriter) Write(b []byte) (int, error) {
	if s.status == 0 {
		s.status = http.StatusOK
	}
	return s.ResponseWriter.Write(b)
}

func (s *statusWriter) Unwrap() http.ResponseWriter { return s.ResponseWriter }
