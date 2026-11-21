package prom

import (
	"context"
	"errors"
	"reflect"
	"sync"
	"sync/atomic"
	"testing"
	"testing/synctest"
	"time"

	"github.com/google/uuid"

	"github.com/digitalis-io/pulsus-dash/server/internal/core"
)

var (
	org      = core.OrgID(uuid.MustParse("01900000-0000-7000-8000-0000000000aa"))
	binding1 = uuid.MustParse("01900000-0000-7000-8000-000000000001")
	binding2 = uuid.MustParse("01900000-0000-7000-8000-000000000002")
)

func rcFor(id uuid.UUID, slug string) *core.RequestCtx {
	return &core.RequestCtx{Tenant: core.TenantCtx{Org: org, Binding: core.TenantBinding{OrgID: org, ID: id, Slug: slug}}}
}

var xCounter = MetricTypes{"x": MetricCounter}

// counting is a Fetch that counts its calls.
type counting struct {
	n  atomic.Int32
	fn func(ctx context.Context) (MetricTypes, error)
}

func (c *counting) fetch(ctx context.Context, _ *core.RequestCtx) (MetricTypes, error) {
	c.n.Add(1)
	return c.fn(ctx)
}

// unit:metric-types-cache C1: hits within the TTL, a new fetch after it.
func TestTypesCacheTTL(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		f := &counting{fn: func(context.Context) (MetricTypes, error) { return xCounter, nil }}
		c := NewTypesCache(f.fetch, CacheOptions{})
		rc := rcFor(binding1, "demo")
		a, err1 := c.Types(t.Context(), rc)
		b, err2 := c.Types(t.Context(), rc)
		time.Sleep(61 * time.Second)
		d, err3 := c.Types(t.Context(), rc)
		if err := errors.Join(err1, err2, err3); err != nil {
			t.Fatal(err)
		}
		if f.n.Load() != 2 || !reflect.DeepEqual(a, xCounter) || !reflect.DeepEqual(b, a) || !reflect.DeepEqual(d, a) {
			t.Errorf("%d fetches; %v %v %v", f.n.Load(), a, b, d)
		}
	})
}

// C2: a failure is held 5 s.
func TestTypesCacheErrorTTL(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		boom := errors.New("boom")
		f := &counting{fn: func(context.Context) (MetricTypes, error) { return nil, boom }}
		c := NewTypesCache(f.fetch, CacheOptions{})
		rc := rcFor(binding1, "demo")
		if _, err := c.Types(t.Context(), rc); !errors.Is(err, boom) {
			t.Fatalf("first: %v", err)
		}
		time.Sleep(4 * time.Second)
		if _, err := c.Types(t.Context(), rc); !errors.Is(err, boom) || f.n.Load() != 1 {
			t.Errorf("+4 s: %v, %d fetches", err, f.n.Load())
		}
		time.Sleep(2 * time.Second)
		if _, err := c.Types(t.Context(), rc); !errors.Is(err, boom) || f.n.Load() != 2 {
			t.Errorf("+6 s: %v, %d fetches", err, f.n.Load())
		}
	})
}

// C3: one entry per binding ID; the slug is not part of the key.
func TestTypesCacheKeys(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		f := &counting{fn: func(context.Context) (MetricTypes, error) { return xCounter, nil }}
		c := NewTypesCache(f.fetch, CacheOptions{})
		for _, rc := range []*core.RequestCtx{rcFor(binding1, "demo"), rcFor(binding2, "demo2")} {
			if _, err := c.Types(t.Context(), rc); err != nil {
				t.Fatal(err)
			}
		}
		if f.n.Load() != 2 {
			t.Errorf("two bindings: %d fetches", f.n.Load())
		}
		for _, rc := range []*core.RequestCtx{rcFor(binding1, "other"), rcFor(binding2, "other2")} {
			if _, err := c.Types(t.Context(), rc); err != nil {
				t.Fatal(err)
			}
		}
		if f.n.Load() != 2 {
			t.Errorf("same IDs, other slugs: %d fetches", f.n.Load())
		}
	})
}

// C4: a waiter that leaves never cancels the fetch, which still fills the entry.
func TestTypesCacheCancelledWaiter(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		release := make(chan struct{})
		var inside error = errors.New("unset")
		f := &counting{fn: func(ctx context.Context) (MetricTypes, error) {
			<-release
			inside = ctx.Err()
			return xCounter, nil
		}}
		c := NewTypesCache(f.fetch, CacheOptions{})
		rc := rcFor(binding1, "demo")
		ctxA, cancelA := context.WithCancel(t.Context())
		var errA, errB error
		var gotB MetricTypes
		var wg sync.WaitGroup
		wg.Add(2)
		go func() { defer wg.Done(); _, errA = c.Types(ctxA, rc) }()
		go func() { defer wg.Done(); gotB, errB = c.Types(t.Context(), rc) }()
		synctest.Wait()
		cancelA()
		synctest.Wait()
		close(release)
		wg.Wait()
		if !errors.Is(errA, context.Canceled) || errB != nil || !reflect.DeepEqual(gotB, xCounter) || inside != nil {
			t.Errorf("A %v; B %v %v; inside the fetch %v", errA, gotB, errB, inside)
		}
		if _, err := c.Types(t.Context(), rc); err != nil || f.n.Load() != 1 {
			t.Errorf("third: %v, %d fetches", err, f.n.Load())
		}
	})
}

// C5: a plan waits at most 2 s; the late answer still fills the entry.
func TestTypesCacheWait(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		f := &counting{fn: func(context.Context) (MetricTypes, error) {
			time.Sleep(3 * time.Second)
			return xCounter, nil
		}}
		c := NewTypesCache(f.fetch, CacheOptions{})
		rc := rcFor(binding1, "demo")
		start := time.Now()
		if _, err := c.Types(t.Context(), rc); !errors.Is(err, ErrTypesWait) || time.Since(start) != 2*time.Second {
			t.Errorf("first: %v after %v", err, time.Since(start))
		}
		time.Sleep(1100 * time.Millisecond)
		got, err := c.Types(t.Context(), rc)
		if err != nil || !reflect.DeepEqual(got, xCounter) || f.n.Load() != 1 {
			t.Errorf("at 3.1 s: %v %v, %d fetches", got, err, f.n.Load())
		}
	})
}

// C6: concurrent misses share one fetch.
func TestTypesCacheSingleflight(t *testing.T) {
	synctest.Test(t, func(t *testing.T) {
		release := make(chan struct{})
		f := &counting{fn: func(context.Context) (MetricTypes, error) { <-release; return xCounter, nil }}
		c := NewTypesCache(f.fetch, CacheOptions{})
		rc := rcFor(binding1, "demo")
		got := make([]MetricTypes, 10)
		errs := make([]error, 10)
		var wg sync.WaitGroup
		for i := range 10 {
			wg.Add(1)
			go func() { defer wg.Done(); got[i], errs[i] = c.Types(t.Context(), rc) }()
		}
		synctest.Wait()
		if f.n.Load() != 1 {
			t.Errorf("%d fetches while waiting", f.n.Load())
		}
		close(release)
		wg.Wait()
		for i := range 10 {
			if errs[i] != nil || !reflect.DeepEqual(got[i], xCounter) {
				t.Errorf("caller %d: %v %v", i, got[i], errs[i])
			}
		}
		if f.n.Load() != 1 {
			t.Errorf("%d fetches", f.n.Load())
		}
	})
}
