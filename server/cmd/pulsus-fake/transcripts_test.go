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
		// The board bar chart set (plan #173 Part 3b §3.2).
		"bars-by-version-base", "bars-by-version", "bars-keys", "bars-many", "bars-trunc", "bars-warn",
		// The board LogQL frame panel's kind probe (plan #67 §5.3).
		"board-logs-probe-checkout",
		"counter-rate", "counter-raw",
		// The engine's DSF cases (plan #68 D2): a matrix cut after its first series (E5), a slow
		// answer (E4).
		"dsf-cut", "dsf-slow",
		"empty", "gauge-range", "histogram",
		// The Inspector set (#192).
		"inspector-hist-sel", "inspector-hist", "inspector-logs-checkout", "inspector-logs-pivot-prod",
		"inspector-logs-pivot", "inspector-logs-sel", "inspector-p99", "inspector-two",
		"labels",
		// The Explore › Logs set (plan #66 Part C §3.13).
		"logs-checkout-1h", "logs-checkout-brushed", "logs-checkout-volume-1h",
		"logs-checkout-volume-brushed", "logs-label-values-app", "logs-labels", "logs-metric-checkout",
		"logs-paging-1", "logs-paging-2", "logs-paging-volume", "logs-parse-error", "logs-slow-volume",
		"logs-slow", "logs-too-broad", "logs-truncated-volume", "logs-truncated",
		"metadata", "metric-names", "parse-error-nopos", "parse-error-position", "runtimeinfo",
		"scalar", "slow-final-chromium", "slow-final-firefox", "slow-final-webkit", "slow",
		"too-broad", "truncated",
	}
	if !slices.Equal(names, want) {
		t.Errorf("transcripts %v, want %v", names, want)
	}
	for _, name := range []string{"runtimeinfo", "histogram", "scalar", "too-broad", "logs-parse-error", "logs-too-broad"} {
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
