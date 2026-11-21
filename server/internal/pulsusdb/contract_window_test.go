package pulsusdb

import (
	"context"
	"errors"
	"testing"
)

// The reference window of the logql contract subtest (A.3 setup). It lives in a file without a
// build tag, so unit:contract-window runs it under ci:go-test with a scripted fetch.
const (
	refMaxAttempts = 20        // upstream requests, the first included
	refMinWidthNs  = 1_000_000 // 1 ms: no request on a narrower window
)

// refOutcome is the outcome of reduceRefWindow.
type refOutcome int

// The outcomes.
const (
	refOK refOutcome = iota
	refEmpty
	refTooDense
)

// refEntry is one entry of the reference.
type refEntry struct {
	TsNs      int64
	StreamKey uint64
	Line      string
}

// reduceRefWindow (stub).
func reduceRefWindow(ctx context.Context, fetch func(ctx context.Context, lo, hi int64) ([]refEntry, error),
	lo, hi int64) (wLo, wHi int64, ref []refEntry, out refOutcome, attempts int, err error) {
	return 0, 0, nil, refOK, 0, nil
}

// refSkipReason (stub).
func refSkipReason(out refOutcome, attempts int, widthNs int64) string { return "" }

const (
	cwL = int64(1767228300000000000)
	cwH = int64(1767228900000000000)
)

// scriptedFetch answers call i with answers[i] (the last repeated): n entries, the newest at T.
type scriptedFetch struct {
	t       *testing.T
	answers []struct {
		n int
		T int64
	}
	calls [][2]int64
	fail  error
	max   int
}

func (s *scriptedFetch) fetch(_ context.Context, lo, hi int64) ([]refEntry, error) {
	s.calls = append(s.calls, [2]int64{lo, hi})
	if s.max > 0 && len(s.calls) > s.max {
		s.t.Fatalf("call %d beyond the bound %d", len(s.calls), s.max)
	}
	if s.fail != nil {
		return nil, s.fail
	}
	a := s.answers[min(len(s.calls)-1, len(s.answers)-1)]
	out := make([]refEntry, a.n)
	for i := range out {
		out[i] = refEntry{TsNs: a.T - int64(i%2), Line: "x"}
	}
	return out, nil
}

func answers(kv ...int64) []struct {
	n int
	T int64
} {
	var out []struct {
		n int
		T int64
	}
	for i := 0; i+1 < len(kv); i += 2 {
		out = append(out, struct {
			n int
			T int64
		}{int(kv[i]), kv[i+1]})
	}
	return out
}

// unit:contract-window (A.3 setup).
func TestContractWindow(t *testing.T) {
	ctx := context.Background()

	// (1) An empty first answer skips.
	f := &scriptedFetch{t: t, answers: answers(0, 0)}
	_, _, _, out, n, err := reduceRefWindow(ctx, f.fetch, cwL, cwH)
	if err != nil || out != refEmpty || n != 1 || refSkipReason(out, n, cwH-cwL) !=
		"logql contract: no entries for DASH_CONTRACT_LOGQL_SELECTOR in (now-15m, now-5m]; choose a selector with recent data" {
		t.Errorf("(1) %v %d %v %q", out, n, err, refSkipReason(out, n, cwH-cwL))
	}

	// (2) Two full answers with T = H, then 1 200.
	f = &scriptedFetch{t: t, answers: answers(5000, cwH, 5000, cwH, 1200, cwH)}
	lo, hi, ref, out, n, err := reduceRefWindow(ctx, f.fetch, cwL, cwH)
	if err != nil || out != refOK || n != 3 || lo != 1767228750000000000 || hi != cwH || len(ref) != 1200 {
		t.Errorf("(2) (%d, %d] %d entries, %v after %d, %v", lo, hi, len(ref), out, n, err)
	}

	// (3) The kept half holds the newest T.
	f = &scriptedFetch{t: t, answers: answers(5000, 1767228400000000000, 10, 1767228400000000000)}
	_, _, _, out, _, err = reduceRefWindow(ctx, f.fetch, cwL, cwH)
	if err != nil || out != refOK || len(f.calls) != 2 || f.calls[1] != [2]int64{cwL, 1767228600000000000} {
		t.Errorf("(3) %v %v calls %v", out, err, f.calls)
	}

	// (4) Always full at H: too dense after exactly 20 calls, never under 1 ms.
	f = &scriptedFetch{t: t, answers: answers(5000, cwH), max: 20}
	_, _, _, out, n, err = reduceRefWindow(ctx, f.fetch, cwL, cwH)
	var last [2]int64
	if len(f.calls) > 0 {
		last = f.calls[len(f.calls)-1]
	}
	if err != nil || out != refTooDense || n != 20 || len(f.calls) != 20 || last != [2]int64{1767228899998855590, cwH} {
		t.Errorf("(4) %v after %d (%d calls), last %v, %v", out, n, len(f.calls), last, err)
	}
	for _, c := range f.calls {
		if c[1]-c[0] < 1_000_000 {
			t.Errorf("(4) window %v under 1 ms", c)
		}
	}
	if g := refSkipReason(out, n, last[1]-last[0]); g !=
		"logql contract: selector too dense: 5000 entries in a 1144410 ns window after 20 requests; choose a narrower selector" {
		t.Errorf("(4) skip text %q", g)
	}

	// (4b) The cap alone: a 1 h start window.
	f = &scriptedFetch{t: t, answers: answers(5000, cwH), max: 20}
	_, _, _, out, n, _ = reduceRefWindow(ctx, f.fetch, cwH-3_600_000_000_000, cwH)
	if out != refTooDense || n != 20 || len(f.calls) != 20 || f.calls[len(f.calls)-1] != [2]int64{1767228899993133544, cwH} {
		t.Errorf("(4b) %v after %d calls, last %v", out, len(f.calls), f.calls)
	}

	// (5) The floor alone: a 3 ms start window.
	f = &scriptedFetch{t: t, answers: answers(5000, cwH), max: 20}
	_, _, _, out, n, _ = reduceRefWindow(ctx, f.fetch, cwH-3_000_000, cwH)
	if out != refTooDense || n != 2 || len(f.calls) != 2 {
		t.Errorf("(5) %v after %d (%d calls), want too dense after 2", out, n, len(f.calls))
	}

	// (6) More than 5 000 entries, or a fetch error: an error and no further call.
	f = &scriptedFetch{t: t, answers: answers(5001, cwH)}
	if _, _, _, _, _, err = reduceRefWindow(ctx, f.fetch, cwL, cwH); err == nil || err.Error() != "limit 5000 returned 5001 entries" || len(f.calls) != 1 {
		t.Errorf("(6) 5 001: %v after %d calls", err, len(f.calls))
	}
	boom := errors.New("boom")
	f = &scriptedFetch{t: t, fail: boom}
	if _, _, _, _, _, err = reduceRefWindow(ctx, f.fetch, cwL, cwH); !errors.Is(err, boom) || len(f.calls) != 1 {
		t.Errorf("(6) fetch error: %v after %d calls", err, len(f.calls))
	}
}
