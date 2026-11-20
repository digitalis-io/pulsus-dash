// Package pulsusfake is a PulsusDB stand-in that replays recorded transcripts (plan #62 §4.7).
package pulsusfake

import (
	"context"
	"errors"
	"net/http"
	"net/url"
	"time"
)

// Options configure a Fake.
type Options struct{ Generate bool }

// Recorded is one request the fake received.
type Recorded struct {
	Transcript           string
	Method, Path         string
	Form                 url.Values
	Header               http.Header
	ReceivedAt           time.Time
	Cancelled, Completed bool
	CancelledAt          time.Time
}

// Fake serves transcripts.
type Fake struct{}

// New returns a fake.
func New(ts []Transcript, o Options) *Fake {
	_, _ = ts, o
	return &Fake{}
}

// ServeHTTP answers one request.
func (f *Fake) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	_ = r
	w.WriteHeader(http.StatusNotImplemented)
}

// Requests returns the recorded requests in arrival order.
func (f *Fake) Requests() []Recorded { return nil }

// WaitCancelled waits until a request answered by transcript was cancelled.
func (f *Fake) WaitCancelled(ctx context.Context, transcript string) (Recorded, error) {
	_, _ = ctx, transcript
	return Recorded{}, errors.New("pulsusfake: not implemented")
}

// Unexpected returns the requests no transcript matched.
func (f *Fake) Unexpected() []Recorded { return nil }

// Reset forgets the recorded requests.
func (f *Fake) Reset() {}
