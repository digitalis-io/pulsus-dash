package spec

import (
	"archive/zip"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

// TestEmbeddedZonesMatchToolchain: embeddedZones (zones_gen.go) are the names of the zoneinfo.zip
// of the toolchain that builds the server (the file time/tzdata embeds). After a Go upgrade, run
// go generate ./internal/spec.
func TestEmbeddedZonesMatchToolchain(t *testing.T) {
	out, err := exec.Command("go", "env", "GOROOT").Output()
	if err != nil {
		t.Fatalf("go env GOROOT: %v", err)
	}
	zr, err := zip.OpenReader(filepath.Join(strings.TrimSpace(string(out)), "lib", "time", "zoneinfo.zip"))
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = zr.Close() }()
	want := map[string]struct{}{}
	for _, f := range zr.File {
		if !strings.HasSuffix(f.Name, "/") {
			want[f.Name] = struct{}{}
		}
	}
	if len(want) < 300 {
		t.Fatalf("zoneinfo.zip holds %d names, want at least 300", len(want))
	}
	if !reflect.DeepEqual(embeddedZones, want) {
		t.Errorf("embeddedZones (%d names) differ from the toolchain's zoneinfo.zip (%d names): run go generate ./internal/spec", len(embeddedZones), len(want))
	}
}
