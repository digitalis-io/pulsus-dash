package gateway

import (
	"os"
	"testing"
)

// bench:cpu-instr (T05-006): each test runs one workload under cachegrind
// (server/scripts/cpu-instr.sh); the script subtracts TestCPUInstrEmpty from W1 and W2.

func cpuInstr(t *testing.T) {
	if os.Getenv("CPU_INSTR") != "1" {
		t.Skip("instruction-count workload; run by server/scripts/cpu-instr.sh (CPU_INSTR=1)")
	}
}

func TestCPUInstrEmpty(t *testing.T) {
	cpuInstr(t)
	runW1(t, 0, 1000)
}

func TestCPUInstrW1(t *testing.T) {
	cpuInstr(t)
	runW1(t, 1000, 1000)
}

func TestCPUInstrW2(t *testing.T) {
	cpuInstr(t)
	runW2(t, 1000, 0)
}

// The workloads succeed (they run in every go test, small).
func TestWorkloadsRun(t *testing.T) {
	runW1(t, 3, 10)
	if d := runW2(t, 3, 0); len(d) != 3 {
		t.Fatalf("W2 ran %d requests", len(d))
	}
}
