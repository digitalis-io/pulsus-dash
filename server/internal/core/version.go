package core

import (
	"runtime"
	"runtime/debug"
)

// Version is the release version, set at build time with
// -ldflags "-X github.com/digitalis-io/pulsus-dash/server/internal/core.Version=…".
var Version = "0.1.0-dev"

// BuildInfo describes the running binary.
type BuildInfo struct {
	Version, Commit, Go string
	Schema              int64
}

// Build returns the build information; schema is the latest migration version embedded in the
// binary. Commit is the VCS revision recorded by the Go toolchain, or "unknown".
func Build(schema int64) BuildInfo {
	commit := "unknown"
	if bi, ok := debug.ReadBuildInfo(); ok {
		for _, s := range bi.Settings {
			if s.Key == "vcs.revision" && s.Value != "" {
				commit = s.Value
			}
		}
	}
	return BuildInfo{Version: Version, Commit: commit, Go: runtime.Version(), Schema: schema}
}
