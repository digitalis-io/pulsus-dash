package main

import (
	"bytes"
	"os"
	"path/filepath"
	"slices"
	"testing"

	"github.com/digitalis-io/pulsus-dash/server/internal/pulsusfake"
)

const e2eTranscripts = "../../../client/e2e/transcripts"

// ci:go-test e2e transcripts: the explore e2e set loads, and its copies match the fake's testdata.
func TestE2ETranscripts(t *testing.T) {
	ts, err := pulsusfake.Load(os.DirFS(e2eTranscripts))
	if err != nil {
		t.Fatal(err)
	}
	var names []string
	for _, tr := range ts {
		names = append(names, tr.Name)
	}
	// Load sorts by file name.
	want := []string{
		"counter-rate", "counter-raw", "empty", "gauge-range", "histogram", "labels", "metadata",
		"metric-names", "parse-error-nopos", "parse-error-position", "runtimeinfo", "scalar", "slow",
		"too-broad", "truncated",
	}
	if !slices.Equal(names, want) {
		t.Errorf("transcripts %v, want %v", names, want)
	}
	for _, name := range []string{"runtimeinfo", "histogram", "scalar", "too-broad"} {
		// #nosec G304 -- fixed test paths under the repository.
		got, err := os.ReadFile(filepath.Join(e2eTranscripts, name+".json"))
		if err != nil {
			t.Errorf("%s: %v", name, err)
			continue
		}
		// #nosec G304 -- fixed test paths under the repository.
		src, err := os.ReadFile(filepath.Join("../../internal/pulsusfake/testdata", name+".json"))
		if err != nil {
			t.Fatal(err)
		}
		if !bytes.Equal(got, src) {
			t.Errorf("%s.json differs from internal/pulsusfake/testdata", name)
		}
	}
}
