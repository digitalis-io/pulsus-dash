package main

import (
	"context"
	"log/slog"
	"time"

	"github.com/digitalis-io/pulsus-dash/server/internal/core"
	"github.com/digitalis-io/pulsus-dash/server/internal/store"
)

// partitionMaintainer is the part of store.Db the maintenance loop uses.
type partitionMaintainer interface {
	MaintainAuditPartitions(ctx context.Context, monthsAhead int) (store.PartitionReport, error)
	AuditPartitionHorizon(ctx context.Context) (int, error)
}

func maintainOnce(ctx context.Context, m partitionMaintainer, logger *slog.Logger, state *core.PartitionState) error {
	return nil
}

func maintainAuditPartitions(ctx context.Context, m partitionMaintainer, logger *slog.Logger, state *core.PartitionState, every, retry time.Duration, ran func(error)) {
}
