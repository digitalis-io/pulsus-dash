// Package fakeharness starts a strict pulsusfake for a test (plan #62 §4.7): every request that
// matches no transcript fails the test when it ends.
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
	// Cleanups run last-in first-out: the server closes before the check.
	t.Cleanup(func() {
		for _, r := range f.Unexpected() {
			t.Errorf("pulsus-fake: unexpected request %s %s", r.Method, r.Path)
		}
	})
	t.Cleanup(srv.Close)
	return f, srv.URL
}
