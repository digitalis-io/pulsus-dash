package arrowwire

import (
	"bytes"
	"reflect"
	"testing"

	"github.com/digitalis-io/pulsus-dash/server/internal/pulsusdb"
)

// unit:coverage-complete (Go side, T04-012): CoverageFrom maps the completeness block.
func TestCoverageFrom(t *testing.T) {
	clean := pulsusdb.Completeness{Warnings: []string{}, Infos: []string{}, QueryID: "q-1", ReadCache: "miss", ReadCacheThroughMs: 1000, NewestSampleMs: -1}
	truncated := clean
	truncated.Truncated = true
	warned := clean
	warned.Warnings, warned.Infos = []string{"w"}, []string{"i"}
	hit := clean
	hit.QueryID, hit.ReadCache, hit.ReadCacheThroughMs, hit.NewestSampleMs = "", "hit", -1, 5
	base := Coverage{Phase: PhaseFinal, Exactness: 4, SeriesReturned: 37, ExcludedDims: []string{}, Warnings: []string{},
		Infos: []string{}, UpstreamQueryIDs: []string{"q-1"}, ReadCache: ptr(uint8(1)), ReadCacheThroughMs: ptr(int64(1000))}
	wantTrunc, wantWarn, wantHit := base, base, base
	wantTrunc.Truncated = true
	wantWarn.Warnings, wantWarn.Infos = []string{"w"}, []string{"i"}
	wantHit.UpstreamQueryIDs, wantHit.ReadCache, wantHit.ReadCacheThroughMs, wantHit.DataEndMs = []string{}, ptr(uint8(0)), nil, ptr(int64(5))
	for name, c := range map[string]struct {
		in   pulsusdb.Completeness
		want Coverage
	}{"clean": {clean, base}, "truncated": {truncated, wantTrunc}, "warning": {warned, wantWarn}, "hit": {hit, wantHit}} {
		got := CoverageFrom(c.in, PhaseFinal, 37)
		if !reflect.DeepEqual(got, c.want) {
			t.Errorf("%s: %+v, want %+v", name, got, c.want)
		}
		if got.RetentionFloorMs != nil || got.Exactness != 4 {
			t.Errorf("%s: retention floor %v, exactness %d", name, got.RetentionFloorMs, got.Exactness)
		}
	}
	for cache, want := range map[string]*uint8{"bypass": ptr(uint8(2)), "other": ptr(uint8(3)), "": nil} {
		c := clean
		c.ReadCache = cache
		if got := CoverageFrom(c, PhasePlanned, 0).ReadCache; !reflect.DeepEqual(got, want) {
			t.Errorf("read_cache %q → %v, want %v", cache, got, want)
		}
	}

	// The encoded coverage/1 row carries the series Finish committed (none here), not the
	// coverage's SeriesReturned (plan #68 D1 §3.3).
	var buf bytes.Buffer
	w := NewWriter(&buf)
	p, err := w.Grid(gridSpec(1, 2, 4), CoverageFrom(clean, PhasePlanned, 0))
	mustOK(t, err)
	mustOK(t, p.Finish(CoverageFrom(hit, PhaseFinal, 37)))
	mustOK(t, w.End())
	got := readBody(t, buf.Bytes()).Parts[0].Coverage
	if len(got) != 2 || got[1].SeriesReturned != 0 || got[1].Phase != uint8(PhaseFinal) || *got[1].ReadCache != 0 || *got[1].DataEnd != 5 {
		t.Errorf("encoded coverage %+v", got)
	}
	if want := toCoverageJSON(CoverageFrom(clean, PhasePlanned, 0)); len(got) == 0 || !reflect.DeepEqual(got[0], want) {
		t.Errorf("encoded planned coverage differs from CoverageFrom")
	}
}
