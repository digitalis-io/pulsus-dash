package main

import (
	"context"
	"log/slog"
	"time"

	"github.com/digitalis-io/pulsus-dash/server/internal/core"
	"github.com/digitalis-io/pulsus-dash/server/internal/store"
)

// Audit partition maintenance in serve (plan #61 §4.4): until the worker's maintenance job
// exists, serve keeps the class-13 leaves three months ahead and drops expired ones.
const (
	auditMonthsAhead   = 3
	auditEveryDefault  = 24 * time.Hour
	auditRetryDefault  = time.Hour
	auditMaintainLimit = time.Minute // one run; the function's lock_timeout is 5 s
)

// partitionMaintainer is the part of store.Db the maintenance loop uses.
type partitionMaintainer interface {
	MaintainAuditPartitions(ctx context.Context, monthsAhead int) (store.PartitionReport, error)
	AuditPartitionHorizon(ctx context.Context) (int, error)
}

// maintainOnce runs one maintenance, records its outcome in state and logs it. It returns the
// maintenance error. When maintenance fails, the horizon is read on its own so that /readyz still
// knows how far the valid leaves reach.
func maintainOnce(ctx context.Context, m partitionMaintainer, logger *slog.Logger, state *core.PartitionState) error {
	runCtx, cancel := context.WithTimeout(ctx, auditMaintainLimit)
	defer cancel()
	rep, err := m.MaintainAuditPartitions(runCtx, auditMonthsAhead)
	if err == nil {
		state.Record(rep.Horizon, true, nil)
		logger.InfoContext(ctx, "audit partitions", "created", rep.Created, "dropped", rep.Dropped, "horizon_months", rep.Horizon)
	} else {
		h, herr := m.AuditPartitionHorizon(runCtx)
		state.Record(h, herr == nil, err)
		logger.ErrorContext(ctx, "audit_partitions_failed", "error", err.Error())
	}
	if check := state.Check(); check == "low" || check == "error" {
		h, known := state.Horizon()
		horizon := any(h)
		if !known {
			horizon = "unknown"
		}
		logger.ErrorContext(ctx, "audit_partition_horizon_low", "state", check, "horizon_months", horizon, "failures", state.Failures())
	}
	return err
}

// maintainAuditPartitions runs maintainOnce now, then after every when a run succeeded and after
// retry when it failed, until ctx is done. ran (tests only) is called after each run.
func maintainAuditPartitions(ctx context.Context, m partitionMaintainer, logger *slog.Logger, state *core.PartitionState, every, retry time.Duration, ran func(error)) {
	if every <= 0 {
		every = auditEveryDefault
	}
	if retry <= 0 {
		retry = auditRetryDefault
	}
	for {
		err := maintainOnce(ctx, m, logger, state)
		if ran != nil {
			ran(err)
		}
		wait := every
		if err != nil {
			wait = retry
		}
		t := time.NewTimer(wait)
		select {
		case <-ctx.Done():
			t.Stop()
			return
		case <-t.C:
		}
	}
}
