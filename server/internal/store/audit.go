package store

import (
	"context"

	"github.com/digitalis-io/pulsus-dash/server/internal/core"
)

// PartitionReport is the result of one audit partition maintenance run.
type PartitionReport struct{ Created, Dropped, Horizon int }

func (t *OrgTx) AppendAudit(ctx context.Context, ev core.AuditEvent) (core.AuditEvent, error) {
	return ev, errStub
}

func AuditHash(prev []byte, org core.OrgID, ev core.AuditEvent) ([32]byte, error) {
	return [32]byte{}, errStub
}

func (d *Db) MaintainAuditPartitions(ctx context.Context, monthsAhead int) (PartitionReport, error) {
	return PartitionReport{}, errStub
}

func (d *Db) AuditPartitionHorizon(ctx context.Context) (int, error) { return 0, errStub }
