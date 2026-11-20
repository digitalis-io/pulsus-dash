package main

import (
	"encoding/json"
	"fmt"

	"github.com/digitalis-io/pulsus-dash/server/internal/core"
	"github.com/digitalis-io/pulsus-dash/server/internal/store"
)

func cmdVersion(e runEnv, args []string) int {
	fs := newFlags(e, "version")
	asJSON := fs.Bool("json", false, "print the version as JSON")
	if !parseFlags(e, fs, args) {
		return exitUsage
	}
	b := core.Build(store.SchemaLatest())
	if *asJSON {
		out := struct {
			Version string `json:"version"`
			Commit  string `json:"commit"`
			Go      string `json:"go"`
			Schema  int64  `json:"schema"`
		}{b.Version, b.Commit, b.Go, b.Schema}
		if err := json.NewEncoder(e.Stdout).Encode(out); err != nil {
			return fail(e, exitRuntime, err.Error())
		}
		return exitOK
	}
	_, _ = fmt.Fprintf(e.Stdout, "pulsus-dash %s (commit %s, %s, schema %d)\n", b.Version, b.Commit, b.Go, b.Schema)
	return exitOK
}
