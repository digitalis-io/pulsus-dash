package main

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"strings"
	"testing"

	"github.com/digitalis-io/pulsus-dash/server/internal/core"
	"github.com/digitalis-io/pulsus-dash/server/internal/store"
)

// fakeMaintainer returns its scripted outcome.
type fakeMaintainer struct {
	rep        store.PartitionReport
	err        error
	horizon    int
	horizonErr error
}

func (f *fakeMaintainer) MaintainAuditPartitions(context.Context, int) (store.PartitionReport, error) {
	return f.rep, f.err
}

func (f *fakeMaintainer) AuditPartitionHorizon(context.Context) (int, error) {
	return f.horizon, f.horizonErr
}

// logRecords returns "LEVEL msg" for every JSON record in out, and clears it.
func logRecords(t *testing.T, out *lockedBuffer) []string {
	t.Helper()
	var recs []string
	for _, line := range strings.Split(strings.TrimSpace(out.String()), "\n") {
		if line == "" {
			continue
		}
		var m map[string]any
		if err := json.Unmarshal([]byte(line), &m); err != nil {
			t.Fatalf("log line %q: %v", line, err)
		}
		recs = append(recs, m["level"].(string)+" "+m["msg"].(string))
	}
	out.mu.Lock()
	out.buf.Reset()
	out.mu.Unlock()
	return recs
}

func TestMaintainOnce(t *testing.T) {
	out := &lockedBuffer{}
	logger := slog.New(slog.NewJSONHandler(out, nil))
	state := &core.PartitionState{}
	ctx := context.Background()
	collision := errors.New("audit_partition_collision: public.audit_events_r13_2027_01 exists but is not the expected partition (SQLSTATE PD001)")

	ok := &fakeMaintainer{rep: store.PartitionReport{Created: 1, Dropped: 0, Horizon: 3}}
	if err := maintainOnce(ctx, ok, logger, state); err != nil {
		t.Fatalf("maintainOnce = %v", err)
	}
	if got := state.Check(); got != "ok" {
		t.Errorf("after ok: Check() = %q, want ok", got)
	}
	if recs := logRecords(t, out); strings.Join(recs, ";") != "INFO audit partitions" {
		t.Errorf("after ok: records %v, want one Info audit partitions", recs)
	}

	failing := &fakeMaintainer{err: collision, horizon: 3}
	if err := maintainOnce(ctx, failing, logger, state); err == nil {
		t.Error("maintainOnce with a failing maintain = nil, want the error")
	}
	if got := state.Check(); got != "low" {
		t.Errorf("after 1 failure: Check() = %q, want low", got)
	}
	if recs := logRecords(t, out); strings.Join(recs, ";") != "ERROR audit_partitions_failed;ERROR audit_partition_horizon_low" {
		t.Errorf("after 1 failure: records %v", recs)
	}
	_ = maintainOnce(ctx, failing, logger, state)
	_ = maintainOnce(ctx, failing, logger, state)
	if got := state.Check(); got != "error" {
		t.Errorf("after 3 failures: Check() = %q, want error", got)
	}
	logRecords(t, out)
	if err := maintainOnce(ctx, ok, logger, state); err != nil || state.Check() != "ok" {
		t.Errorf("recovery: %v, Check() = %q; want ok", err, state.Check())
	}
	logRecords(t, out)

	fresh := &core.PartitionState{}
	both := &fakeMaintainer{err: errors.New("down"), horizonErr: errors.New("down")}
	_ = maintainOnce(ctx, both, logger, fresh)
	if _, known := fresh.Horizon(); fresh.Check() != "low" || fresh.Failures() != 1 || known {
		t.Errorf("both failing on a fresh state: Check() = %q, failures %d, known %v; want low, 1, false", fresh.Check(), fresh.Failures(), known)
	}
	if recs := logRecords(t, out); strings.Join(recs, ";") != "ERROR audit_partitions_failed;ERROR audit_partition_horizon_low" {
		t.Errorf("both failing: records %v", recs)
	}
}
