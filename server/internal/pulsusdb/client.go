// Package pulsusdb is the only code that calls PulsusDB (T06-005).
package pulsusdb

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"time"
)

// Options configure a Client.
type Options struct {
	TenantConcurrency int
	Secrets           func(ref string) (string, error)
	Logger            *slog.Logger
	Now               func() time.Time
	Sleep             func(ctx context.Context, d time.Duration) error
	Jitter            func() float64
	Transport         http.RoundTripper
	Limits            Limits
	Timeouts          Timeouts
}

// Limits bound everything read from PulsusDB.
type Limits struct {
	DataBody, MetaBody, ErrorBody int64
	MaxPoints                     int
	MaxValues                     int
	TextBytes, MaxMessages        int
}

// DefaultLimits are the production limits.
var DefaultLimits = Limits{256 << 20, 32 << 20, 64 << 10, 5_000_000, 10_000, 1024, 20}

// Timeouts apply when the caller's ctx has a later (or no) deadline.
type Timeouts struct {
	Metadata time.Duration
	Check    time.Duration
}

// DefaultTimeouts are the production timeouts.
var DefaultTimeouts = Timeouts{Metadata: 10 * time.Second, Check: 5 * time.Second}

// Client calls PulsusDB.
type Client struct{ o Options }

// New returns a client.
func New(o Options) *Client { return &Client{o: o} }

var errStub = errors.New("pulsusdb: not implemented")
