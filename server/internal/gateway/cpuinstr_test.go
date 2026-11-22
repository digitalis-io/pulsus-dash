package gateway

import (
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// bench:cpu-instr (T05-006, plan #62 A.11). server/scripts/cpu-instr.sh first runs
// TestCPUInstrBodies without valgrind (CPU_INSTR_WRITE=<dir>): it writes the upstream bodies, so
// building the 10⁶-point input is never counted. Each workload test then runs once under
// cachegrind (CPU_INSTR=1, CPU_INSTR_BODIES=<dir>) and reads its body from that directory.
// TestCPUInstrEmpty reads the same W1 file but is served a 0-series answer, so W1 − Empty counts
// exactly the decode, grid placement and encode of the 10⁶ points (the A.11 boundary: from the
// first read of the upstream body to the last byte written); the file read and the harness cancel
// out. W2 − Empty counts 1 000 requests through the gateway, and W3 − Empty one 5 000-entry log
// page (plan #65 Part B §8.1). Every workload reads w1.json, empty.json and w3.json, so the file
// reads cancel out.

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
		"w3.json": logPageBody(w3Streams, w3PerStream),
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
	_ = body(t, "w3.json")
	newW1Body(body(t, "empty.json"), w1Points).run(t)
}

func TestCPUInstrW1(t *testing.T) {
	cpuInstr(t)
	newW1Body(body(t, "w1.json"), w1Points).run(t)
	_ = body(t, "empty.json") // read as Empty reads it
	_ = body(t, "w3.json")
}

func TestCPUInstrW2(t *testing.T) {
	cpuInstr(t)
	_ = body(t, "w1.json")
	_ = body(t, "empty.json")
	_ = body(t, "w3.json")
	runW2Body(t, body(t, "w2.json"), 1000, 0)
}

func TestCPUInstrW3(t *testing.T) {
	cpuInstr(t)
	_ = body(t, "w1.json")
	_ = body(t, "empty.json")
	newW3Body(body(t, "w3.json")).run(t)
}

// The workloads succeed (they run in every go test, small).
func TestWorkloadsRun(t *testing.T) {
	runW1(t, 3, 10)
	if d := runW2(t, 3, 0); len(d) != 3 {
		t.Fatalf("W2 ran %d requests", len(d))
	}
	newW3Body(logPageBody(3, 10)).run(t)
}

// The W3 body is the page of §8.1: 5 000 entries, ties every 10th, the last group single, and one
// upstream request for the page.
func TestW3Body(t *testing.T) {
	m := &memTransport{body: logPageBody(w3Streams, w3PerStream)}
	n := 0
	h := workloadGateway(&countTransport{rt: m, n: &n})
	body := fmt.Sprintf(`{"query":"{app=\"bench\"}","from":%d,"to":%d,"width_px":1200,"limit":%d}`, workloadFrom, workloadFrom+3_600_000, w3Limit)
	rec := postJSON(h, logRangePath, body)
	if rec.Code != 200 || n != 1 || strings.Count(rec.Body.String(), `"ts_ns"`) != 4999 || !strings.Contains(rec.Body.String(), `"cursor":"`) {
		t.Errorf("W3: %d, %d upstream requests, %d entries", rec.Code, n, strings.Count(rec.Body.String(), `"ts_ns"`))
	}
}

// countTransport counts the round trips of rt.
type countTransport struct {
	rt http.RoundTripper
	n  *int
}

func (c *countTransport) RoundTrip(r *http.Request) (*http.Response, error) {
	*c.n++
	return c.rt.RoundTrip(r)
}
