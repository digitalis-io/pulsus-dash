// Command pulsus-fake serves the PulsusDB transcripts of internal/pulsusfake for the dev stack
// (plan #62 §4.7): pulsus-fake [--listen ADDR] [--transcripts DIR] [--generate=true|false].
package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"net"
	"net/http"
	"os"
	"os/signal"
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
	f := pulsusfake.New(ts, pulsusfake.Options{Generate: *generate})
	enc := json.NewEncoder(os.Stdout)
	h := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		sw := &statusWriter{ResponseWriter: w}
		rec := f.Serve(sw, r)
		_ = enc.Encode(map[string]any{"method": rec.Method, "path": rec.Path, "transcript": rec.Transcript,
			"status": sw.status, "cancelled": rec.Cancelled})
		f.Reset() // the dev fake keeps no history: memory stays bounded
	})
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
