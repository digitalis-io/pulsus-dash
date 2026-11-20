package gateway

import (
	"os"
	"path/filepath"
	"testing"
)

// bench:cpu-instr (T05-006, plan #62 A.11). server/scripts/cpu-instr.sh first runs
// TestCPUInstrBodies without valgrind (CPU_INSTR_WRITE=<dir>): it writes the upstream bodies, so
// building the 10⁶-point input is never counted. Each workload test then runs once under
// cachegrind (CPU_INSTR=1, CPU_INSTR_BODIES=<dir>) and reads its body from that directory.
// TestCPUInstrEmpty reads the same W1 file but is served a 0-series answer, so W1 − Empty counts
// exactly the decode, grid placement and encode of the 10⁶ points (the A.11 boundary: from the
// first read of the upstream body to the last byte written); the file read and the harness cancel
// out. W2 − Empty counts 1 000 requests through the gateway.

const (
	w1Series, w1Points = 1000, 1000
	w2Series, w2Points = 1, 60
)

func cpuInstr(t *testing.T) {
	if os.Getenv("CPU_INSTR") != "1" {
		t.Skip("instruction-count workload; run by server/scripts/cpu-instr.sh (CPU_INSTR=1)")
	}
}

// TestCPUInstrBodies writes the workload bodies (run by cpu-instr.sh before valgrind).
func TestCPUInstrBodies(t *testing.T) {
	dir := os.Getenv("CPU_INSTR_WRITE")
	if dir == "" {
		t.Skip("writes the cpu-instr bodies; run by server/scripts/cpu-instr.sh (CPU_INSTR_WRITE=<dir>)")
	}
	for name, body := range map[string][]byte{
		"w1.json": matrixBody(w1Series, w1Points), "w2.json": matrixBody(w2Series, w2Points), "empty.json": matrixBody(0, w1Points),
	} {
		if err := os.WriteFile(filepath.Join(dir, name), body, 0o600); err != nil { // #nosec G703 -- the script's temporary directory
			t.Fatal(err)
		}
	}
}

// body reads one body written by TestCPUInstrBodies.
func body(t *testing.T, name string) []byte {
	b, err := os.ReadFile(filepath.Join(os.Getenv("CPU_INSTR_BODIES"), name)) // #nosec G304 G703 -- the script's temporary directory
	if err != nil {
		t.Fatalf("cpu-instr body %s: %v (CPU_INSTR_BODIES)", name, err)
	}
	return b
}

func TestCPUInstrEmpty(t *testing.T) {
	cpuInstr(t)
	_ = body(t, "w1.json") // read as W1 reads it, so the read cancels out
	newW1Body(body(t, "empty.json"), w1Points).run(t)
}

func TestCPUInstrW1(t *testing.T) {
	cpuInstr(t)
	newW1Body(body(t, "w1.json"), w1Points).run(t)
	_ = body(t, "empty.json") // read as Empty reads it
}

func TestCPUInstrW2(t *testing.T) {
	cpuInstr(t)
	_ = body(t, "w1.json")
	_ = body(t, "empty.json")
	runW2Body(t, body(t, "w2.json"), 1000, 0)
}

// The workloads succeed (they run in every go test, small).
func TestWorkloadsRun(t *testing.T) {
	runW1(t, 3, 10)
	if d := runW2(t, 3, 0); len(d) != 3 {
		t.Fatalf("W2 ran %d requests", len(d))
	}
}
