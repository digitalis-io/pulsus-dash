package arrowwire

import (
	"bytes"
	"errors"
	"io"
	"os"
	"path/filepath"
	"reflect"
	"strconv"
	"strings"
	"testing"
	uni "unicode/utf8"
)

// liftedLimits are DefaultLimits without the B3 string, label and budget limits, which cut
// coverage and error strings and refuse label sets far below MaxPayload: with them the B1
// frame-size paths (bounded close, frame-too-large refusal) are reachable.
func liftedLimits() Limits {
	l := DefaultLimits()
	l.MetaStringBytes, l.MetaListElements, l.LabelBytesPerPart = 1<<30, 1<<30, 1<<30
	l.BodyBudget, l.ValueBudget = 1<<40, 1<<40
	return l
}

// An oversized coverage or error given to Fail still closes the part on the wire (outcome (b)):
// the closing labels batch, a bounded partial META and the ERROR with the upstream code; the
// Writer stays usable for the next part. (With DefaultLimits the B3 cut policy keeps both far
// below MaxPayload: limits-fail and unit:wire-limits.)
func TestFailOversized(t *testing.T) {
	big := strings.Repeat("w", 40<<20)
	cases := []struct {
		name string
		cov  Coverage
		row  ErrorRow
	}{
		{"coverage past MaxPayload", Coverage{Phase: PhasePartial, Warnings: []string{big, big}, SeriesReturned: 1},
			ErrorRow{Code: 1, HTTPStatus: 422, Message: "too broad", Suggestion: ptr("add a label matcher")}},
		{"error past MaxPayload", Coverage{Phase: PhasePartial, SeriesReturned: 1},
			ErrorRow{Code: 5, HTTPStatus: 504, Message: big + big, Position: ptr(uint32(3))}},
	}
	for i, c := range cases {
		w, buf := completedPartWith(t, liftedLimits())
		p, err := w.Grid(gridSpec(3, 4, 4), Coverage{})
		mustOK(t, err)
		mustOK(t, p.Add(rampSeries(0, 4)))
		open := buf.Len()
		if err := p.Fail(c.cov, c.row); !errors.Is(err, ErrFrameTooLarge) {
			t.Errorf("%s: Fail %v, want ErrFrameTooLarge", c.name, err)
		}
		rest := splitFrames(t, buf.Bytes()[open:])
		want := []seqItem{{FrameBatch, 3, FlagLast}, {FrameMeta, 4, 0}, {FrameError, 4, FlagLast}}
		if got := frameSeq(t, buf.Bytes()[open:]); !reflect.DeepEqual(got, want) {
			t.Fatalf("%s: close %v, want %v", c.name, got, want)
		}
		for _, f := range rest {
			checkLayout(t, c.name, f.Payload, f.Off+HeaderLen)
		}
		if dir := os.Getenv("ARROWWIRE_DUMP_DIR"); dir != "" { // the bounded close frames for external checks
			mustOK(t, os.WriteFile(filepath.Join(dir, "fail-oversized-"+strconv.Itoa(i)+".dsf"), buf.Bytes(), 0o600)) // #nosec G703 -- a directory the developer names for a local check
		}
		cov := coverageOf(t, rest[1].Payload)
		if cov.Phase != uint8(PhasePartial) || !cov.Truncated || cov.TruncationReason == nil || cov.SeriesReturned != 1 {
			t.Errorf("%s: bounded coverage %+v", c.name, cov)
		}
		n := 0
		for _, s := range append(append(append(cov.ExcludedDims, cov.Warnings...), cov.Infos...), cov.UpstreamQueryIDs...) {
			n += len(s)
		}
		if n > boundListBytes {
			t.Errorf("%s: %d list bytes kept", c.name, n)
		}
		e := errorOf(t, rest[2].Payload)
		if e.Code != c.row.Code || e.HTTPStatus != c.row.HTTPStatus || !reflect.DeepEqual(e.Position, c.row.Position) {
			t.Errorf("%s: error %d %d, want the upstream %d %d", c.name, e.Code, e.HTTPStatus, c.row.Code, c.row.HTTPStatus)
		}
		if len(c.row.Message) <= boundMessage && e.Message != c.row.Message {
			t.Errorf("%s: message %q, want %q", c.name, e.Message, c.row.Message)
		}
		if len(c.row.Message) > boundMessage && (len(e.Message) > boundMessage || !strings.HasSuffix(e.Message, cutMarker)) {
			t.Errorf("%s: message of %d bytes not cut to the bound", c.name, len(e.Message))
		}
		if err := p.Add(rampSeries(1, 4)); !errors.Is(err, ErrOrder) {
			t.Errorf("%s: later Add %v, want ErrOrder", c.name, err)
		}
		q, err := w.Grid(gridSpec(5, 6, 4), Coverage{})
		mustOK(t, err)
		mustOK(t, q.Add(rampSeries(0, 4)))
		mustOK(t, q.Finish(Coverage{Phase: PhaseFinal, SeriesReturned: 1}))
		mustOK(t, w.End())
		if got := readBody(t, buf.Bytes()); len(got.Parts) != 3 {
			t.Errorf("%s: %d parts read back, want 3", c.name, len(got.Parts))
		}
	}
}

// failWriter accepts limit bytes, then fails; short makes it return a short count instead.
type failWriter struct {
	buf   bytes.Buffer
	limit int
	short bool
	calls int
}

var errSink = errors.New("sink failed")

func (f *failWriter) Write(b []byte) (int, error) {
	f.calls++
	room := f.limit - f.buf.Len()
	if len(b) <= room {
		return f.buf.Write(b)
	}
	f.buf.Write(b[:max(room, 0)])
	if f.short {
		return max(room, 0), nil
	}
	return max(room, 0), errSink
}

// A write error or a short write of the io.Writer is sticky: the call returns it, and every
// later call returns it without writing.
func TestStickyWriteError(t *testing.T) {
	for _, short := range []bool{false, true} {
		for _, limit := range []int{0, 10, 2000} {
			fw := &failWriter{limit: limit, short: short}
			w := NewWriter(fw)
			p, err := w.Grid(gridSpec(1, 2, 4), Coverage{})
			want := errSink
			if short {
				want = io.ErrShortWrite
			}
			if !errors.Is(err, want) {
				t.Fatalf("short=%v limit=%d: Grid %v, want %v", short, limit, err, want)
			}
			if p != nil {
				t.Errorf("short=%v limit=%d: Grid returned a part", short, limit)
			}
			n, calls := fw.buf.Len(), fw.calls
			for name, call := range map[string]func() error{
				"Grid":  func() error { _, err := w.Grid(gridSpec(3, 4, 4), Coverage{}); return err },
				"Error": func() error { return w.Error(5, 0, ErrorRow{Message: "x"}) },
				"End":   w.End,
			} {
				if err := call(); !errors.Is(err, want) {
					t.Errorf("short=%v limit=%d: later %s %v, want the sticky %v", short, limit, name, err, want)
				}
			}
			if fw.buf.Len() != n || fw.calls != calls {
				t.Errorf("short=%v limit=%d: %d more bytes, %d more writes after the error", short, limit, fw.buf.Len()-n, fw.calls-calls)
			}
		}
	}

	// A write error inside an open part: Add, Flush, Finish and Fail all return it.
	fw := &failWriter{limit: 1 << 30}
	w := NewWriter(fw)
	p, err := w.Grid(gridSpec(1, 2, 4), Coverage{})
	mustOK(t, err)
	fw.limit = fw.buf.Len()
	if err := p.Add(rampSeries(0, 4)); !errors.Is(err, errSink) {
		t.Fatalf("Add %v, want the write error", err)
	}
	n := fw.buf.Len()
	for name, call := range map[string]func() error{
		"Add":    func() error { return p.Add(rampSeries(1, 4)) },
		"Flush":  p.Flush,
		"Finish": func() error { return p.Finish(Coverage{Phase: PhaseFinal}) },
		"Fail":   func() error { return p.Fail(Coverage{}, ErrorRow{}) },
		"End":    w.End,
	} {
		if err := call(); !errors.Is(err, errSink) {
			t.Errorf("later %s %v, want the sticky write error", name, err)
		}
	}
	if fw.buf.Len() != n {
		t.Errorf("%d bytes written after the error", fw.buf.Len()-n)
	}
}

// labelsFrame adds one series labelled {big="x"×v} to parts 3/4 after a completed part and
// returns the labels BATCH(3) payload length (0 if none), the body and Add's error.
func labelsFrame(t *testing.T, v int) (int, []byte, error) {
	t.Helper()
	w, buf := completedPartWith(t, liftedLimits())
	p, err := w.Grid(gridSpec(3, 4, 4), Coverage{})
	mustOK(t, err)
	s := newSeries([]float64{1, 2, 3, 4}, []bool{true, true, true, true}, "big", strings.Repeat("x", v))
	aerr := p.Add(s)
	for _, f := range splitFrames(t, buf.Bytes()) {
		if f.Type == FrameBatch && f.PartID == 3 && f.Flags&FlagLast == 0 {
			return int(f.PayloadLen), buf.Bytes(), aerr
		}
	}
	return 0, buf.Bytes(), aerr
}

// A series is refused only when its encoded labels frame is larger than MaxPayload: a label
// that makes the frame exactly MaxPayload is written, 1 byte more is refused (outcome (b)).
// With DefaultLimits such a label set is above label_bytes_per_part (B3, wire_limit), so this
// runs with liftedLimits.
func TestLabelsAtPayloadLimit(t *testing.T) {
	const v0 = 1 << 20
	p0, _, err := labelsFrame(t, v0)
	mustOK(t, err)
	vMax := v0 + MaxPayload - p0 // the payload grows 1:1 with an 8-aligned value length
	p, body, err := labelsFrame(t, vMax)
	if err != nil || p != MaxPayload {
		t.Fatalf("value of %d bytes: Add %v, labels payload %d, want written at exactly %d", vMax, err, p, MaxPayload)
	}
	checkAlignment(t, "labels at limit", body)
	p, body, err = labelsFrame(t, vMax+1)
	if !errors.Is(err, ErrFrameTooLarge) || p != 0 {
		t.Fatalf("value of %d bytes: Add %v, labels payload %d, want ErrFrameTooLarge and no batch", vMax+1, err, p)
	}
	frames := splitFrames(t, body)
	last := frames[len(frames)-1]
	if last.Type != FrameError || last.PartID != 4 || errorOf(t, last.Payload).Message != "writer refused: frame too large" {
		t.Errorf("refused series: last frame %v part %d", last.Type, last.PartID)
	}
}

// cutUTF8 never exceeds its budget, cuts at a UTF-8 boundary and omits the marker when the
// budget is shorter than it.
func TestCutUTF8(t *testing.T) {
	m := len(cutMarker)
	cases := []struct {
		s    string
		n    int
		want string
	}{
		{"abc", 3, "abc"},
		{strings.Repeat("a", 20), m, cutMarker},                 // only the marker fits
		{strings.Repeat("a", 20), m + 2, "aa" + cutMarker},      // ASCII cut
		{strings.Repeat("a", 20), 5, "aaaaa"},                   // shorter than the marker: omitted
		{strings.Repeat("a", 20), 0, ""},                        // no budget
		{"a" + strings.Repeat("✓", 10), m + 2, "a" + cutMarker}, // cut inside "✓": back to its start
		{strings.Repeat("✓", 6), 5, "✓"},                        // inside "✓", no marker
		{"é" + strings.Repeat("é", 10), m + 3, "é" + cutMarker}, // cut inside the second "é"
		{strings.Repeat("é", 3), 6, strings.Repeat("é", 3)},     // fits exactly
	}
	for _, c := range cases {
		got := cutUTF8(c.s, c.n)
		if got != c.want || len(got) > max(c.n, len(c.s)) || (len(c.s) > c.n && len(got) > c.n) || !uni.ValidString(got) {
			t.Errorf("cutUTF8(%q, %d) = %q, want %q", c.s, c.n, got, c.want)
		}
	}

	// The 1 MiB total of the bounded lists holds when the remaining budget is below the marker.
	c := boundCoverage(Coverage{Warnings: []string{strings.Repeat("w", boundListBytes-5), strings.Repeat("x", 100), "y"}, Infos: []string{"z"}})
	n := 0
	for _, s := range append(append(c.Warnings, c.Infos...), append(c.ExcludedDims, c.UpstreamQueryIDs...)...) {
		n += len(s)
	}
	if n > boundListBytes || len(c.Warnings) != 2 || c.Warnings[1] != "xxxxx" || len(c.Infos) != 0 {
		t.Errorf("bounded lists: %d bytes, warnings %d (second %q), infos %v", n, len(c.Warnings), c.Warnings[min(1, len(c.Warnings)-1)][:min(10, len(c.Warnings[min(1, len(c.Warnings)-1)]))], c.Infos)
	}
}
