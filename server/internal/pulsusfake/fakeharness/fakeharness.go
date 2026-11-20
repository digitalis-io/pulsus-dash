// Package fakeharness starts a strict pulsusfake for a test.
package fakeharness

import (
	"net/http/httptest"
	"testing"

	"github.com/digitalis-io/pulsus-dash/server/internal/pulsusfake"
)

// Start serves the default transcripts on an httptest server and returns the fake and its URL.
func Start(t testing.TB) (*pulsusfake.Fake, string) {
	t.Helper()
	f := pulsusfake.New(pulsusfake.Default(), pulsusfake.Options{})
	srv := httptest.NewServer(f)
	t.Cleanup(srv.Close)
	return f, srv.URL
}
