package core

import (
	"errors"
	"testing"
)

type rec struct {
	h     int
	known bool
	err   error
}

func TestPartitionStateCheck(t *testing.T) {
	fail := rec{3, true, errors.New("PD001")}
	ok := func(h int) rec { return rec{h, true, nil} }
	cases := []struct {
		name string
		runs []rec
		want string
	}{
		{"none", nil, "unknown"},
		{"ok h3", []rec{ok(3)}, "ok"},
		{"ok h2", []rec{ok(2)}, "ok"},
		{"ok h1", []rec{ok(1)}, "low"},
		{"ok h0", []rec{ok(0)}, "low"},
		{"ok h-1", []rec{ok(-1)}, "error"},
		{"fail x1", []rec{fail}, "low"},
		{"fail x2", []rec{fail, fail}, "low"},
		{"fail x3", []rec{fail, fail, fail}, "error"},
		{"fail x3 then ok", []rec{fail, fail, fail, ok(3)}, "ok"},
		{"fail without horizon keeps it", []rec{ok(3), {0, false, errors.New("down")}}, "low"},
		{"fail without horizon on a fresh state", []rec{{0, false, errors.New("down")}}, "low"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			var s PartitionState
			for _, r := range tc.runs {
				s.Record(r.h, r.known, r.err)
			}
			if got := s.Check(); got != tc.want {
				t.Errorf("Check() = %q, want %q", got, tc.want)
			}
		})
	}
	var s PartitionState
	s.Record(3, true, nil)
	s.Record(0, false, errors.New("down"))
	if h, known := s.Horizon(); h != 3 || !known || s.Failures() != 1 {
		t.Errorf("Horizon() = %d %v, Failures() = %d; want 3 true 1", h, known, s.Failures())
	}
}
