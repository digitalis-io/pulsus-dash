package pulsusdb

import (
	"context"
	"sync"
	"time"

	"github.com/google/uuid"
)

// retryBudget allows a retry only while retries stay within 10 % of the requests of the last
// 10 s, per cluster (T06-009). Every attempt is a request; every retry is also a retry.
type retryBudget struct {
	mu       sync.Mutex
	clusters map[string]*[budgetBuckets]bucket
}

const budgetBuckets = 10 // one-second buckets

type bucket struct {
	sec           int64
	requests, ret int
}

func newRetryBudget() *retryBudget {
	return &retryBudget{clusters: map[string]*[budgetBuckets]bucket{}}
}

// record counts one attempt (and one retry if retry) at now.
func (b *retryBudget) record(cluster string, now time.Time, retry bool) {
	b.mu.Lock()
	defer b.mu.Unlock()
	w := b.clusters[cluster]
	if w == nil {
		w = &[budgetBuckets]bucket{}
		b.clusters[cluster] = w
	}
	sec := now.Unix()
	bk := &w[sec%budgetBuckets]
	if bk.sec != sec {
		*bk = bucket{sec: sec}
	}
	bk.requests++
	if retry {
		bk.ret++
	}
}

// allow reports whether one more retry fits: retries + 1 ≤ ⌊0.1 × (requests + 1)⌋ over the
// window, counting the retry itself in both.
func (b *retryBudget) allow(cluster string, now time.Time) bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	w := b.clusters[cluster]
	requests, retries := 0, 0
	if w != nil {
		sec := now.Unix()
		for _, bk := range w {
			if bk.sec > sec-budgetBuckets && bk.sec <= sec {
				requests += bk.requests
				retries += bk.ret
			}
		}
	}
	return (retries+1)*10 <= requests+1
}

// slotWait is how long a call waits for a tenant slot before KindBusy.
const slotWait = 50 * time.Millisecond

// tenantLimiter bounds the calls in flight per tenant binding (T06 §4.10).
type tenantLimiter struct {
	n     int
	slots sync.Map // uuid.UUID → chan struct{} with capacity n
}

// acquire takes a slot of binding id, waiting at most 50 ms; the returned func frees it once.
func (l *tenantLimiter) acquire(ctx context.Context, id uuid.UUID) (func(), error) {
	v, ok := l.slots.Load(id)
	if !ok {
		v, _ = l.slots.LoadOrStore(id, make(chan struct{}, l.n))
	}
	ch := v.(chan struct{})
	release := sync.OnceFunc(func() { <-ch })
	select {
	case ch <- struct{}{}:
		return release, nil
	default:
	}
	t := time.NewTimer(slotWait)
	defer t.Stop()
	select {
	case ch <- struct{}{}:
		return release, nil
	case <-t.C:
		return nil, newError(KindBusy)
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}
