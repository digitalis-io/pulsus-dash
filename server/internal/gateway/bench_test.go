package gateway

import (
	"os"
	"slices"
	"testing"
	"time"
)

func referenceLab(t *testing.T) {
	if os.Getenv("REFERENCE_LAB") != "1" {
		t.Skip("reference lab only (T05-006)")
	}
}

// bench:promql-decode (lab gate, T06 §7): ≤ 30 ms per 10⁶ points, median of 5.
func TestBudgetPromqlDecode(t *testing.T) {
	referenceLab(t)
	var ms []float64
	for range 5 {
		r := testing.Benchmark(func(b *testing.B) {
			for b.Loop() {
				runW1(b, 1000, 1000)
			}
		})
		ms = append(ms, float64(r.NsPerOp())/1e6) // 10⁶ points per op
	}
	slices.Sort(ms)
	t.Logf("promql decode: %.2f ms per 10⁶ points (median of 5: %v)", ms[2], ms)
	if ms[2] > 30 {
		t.Fatalf("promql decode %.2f ms per 10⁶ points, budget 30 ms", ms[2])
	}
}

// bench:bff-overhead (lab gate, T06 §7): p50 ≤ 5 ms and p99 ≤ 20 ms over 1 000 requests.
func TestBudgetBffOverhead(t *testing.T) {
	referenceLab(t)
	d := runW2(t, 1000, 2*time.Millisecond)
	slices.Sort(d)
	p50, p99 := d[len(d)/2], d[len(d)*99/100]
	t.Logf("BFF overhead: p50 %v p99 %v", p50, p99)
	if p50 > 5*time.Millisecond || p99 > 20*time.Millisecond {
		t.Fatalf("BFF overhead p50 %v p99 %v, budget 5 ms / 20 ms", p50, p99)
	}
}
