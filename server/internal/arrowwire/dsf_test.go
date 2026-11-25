package arrowwire

import (
	"bytes"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"testing"

	"github.com/apache/arrow-go/v18/arrow/array"
)

// unit:dsf-header (T04-009).
func TestHeader(t *testing.T) {
	h := Header{Type: FrameBatch, Flags: 3, PartID: 0x01020304, PayloadLen: 16, Rank: 0x0506}
	want := []byte{0x01, 0x02, 0x03, 0x00, 0x04, 0x03, 0x02, 0x01, 0x10, 0x00, 0x00, 0x00, 0x06, 0x05, 0x00, 0x00}
	b := AppendHeader([]byte{0xAA}, h)
	if !bytes.Equal(b, append([]byte{0xAA}, want...)) {
		t.Fatalf("AppendHeader % x, want % x", b, want)
	}
	if got, err := ParseHeader(want); err != nil || got != h {
		t.Fatalf("ParseHeader %+v %v, want %+v", got, err, h)
	}
	bad := map[string][]byte{}
	for name, patch := range map[string]func(b []byte){
		"version 2":    func(b []byte) { b[0] = 2 },
		"reserved ≠ 0": func(b []byte) { b[15] = 1 },
		"type 0":       func(b []byte) { b[1] = 0 },
		"type 9":       func(b []byte) { b[1] = 9 },
		"len > max":    func(b []byte) { b[8], b[9], b[10], b[11] = 0x01, 0x00, 0x00, 0x04 }, // 64 MiB + 1
	} {
		c := append([]byte(nil), want...)
		patch(c)
		bad[name] = c
	}
	bad["short (15 B)"] = want[:15]
	for name, b := range bad {
		if _, err := ParseHeader(b); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
	if _, err := ParseHeader(bad["len > max"]); !errors.Is(err, ErrFrameTooLarge) {
		t.Errorf("len > max: %v, want ErrFrameTooLarge", err)
	}
	atMax := append([]byte(nil), want...)
	atMax[8], atMax[9], atMax[10], atMax[11] = 0, 0, 0, 0x04 // exactly MaxPayload
	if got, err := ParseHeader(atMax); err != nil || got.PayloadLen != MaxPayload {
		t.Errorf("len = MaxPayload: %+v %v", got, err)
	}
}

// addr is the address of a buffer's first byte (reflect: no unsafe).
func addr(b []byte) uintptr { return reflect.ValueOf(b).Pointer() }

// checkAlignment checks §3.2 on one body: frame lengths ≡ 0 (mod 8), IPC bodies ≡ 0 (mod 64),
// and, read back with arrow-go's Go allocator, every grid values and series_id buffer at an
// address ≡ 0 (mod 64).
func checkAlignment(t *testing.T, name string, b []byte) {
	t.Helper()
	data := map[uint32]bool{}
	streams := map[uint32][]byte{}
	for _, f := range splitFrames(t, b) {
		if (HeaderLen+len(f.Payload))%8 != 0 {
			t.Errorf("%s: frame at %d has length %d", name, f.Off, HeaderLen+len(f.Payload))
		}
		if len(f.Payload) == 0 {
			continue
		}
		ms, _ := messages(t, f.Payload, f.Off+HeaderLen)
		for _, m := range ms {
			if m.BodyOff%64 != 0 {
				t.Errorf("%s: message at %d has its body at %d", name, m.Off, m.BodyOff)
			}
		}
		if f.Type == FrameMeta && f.PartID != 0 {
			data[f.PartID] = true
		}
		if f.Type == FrameSchema || f.Type == FrameBatch {
			streams[f.PartID] = append(streams[f.PartID], f.Payload...)
		}
	}
	for part := range data {
		_, recs := readStream(t, streams[part])
		for _, r := range recs {
			ids := r.Column(0).Data().Buffers()[1].Bytes()
			vals := r.Column(1).(*array.FixedSizeList).ListValues().Data().Buffers()[1].Bytes()
			if addr(ids)%64 != 0 || addr(vals)%64 != 0 {
				t.Errorf("%s part %d: series_id at %d, values at %d (mod 64)", name, part, addr(ids)%64, addr(vals)%64)
			}
		}
	}
}

// unit:arrow-alignment (Go side, T04 §4.2).
func TestAlignment(t *testing.T) {
	for _, fx := range fixtures {
		b, err := os.ReadFile(filepath.Join(fixtureDir, fx.name+".dsf"))
		if err != nil {
			t.Fatalf("%v (run TestFixtures -update)", err)
		}
		checkAlignment(t, fx.name, b)
	}
	for seed := uint64(1); seed <= 50; seed++ {
		b, _ := propBody(t, seed)
		checkAlignment(t, "prop", b)
	}
	for _, rows := range []int{1, 5, 64} {
		for _, n := range []int{1, 3, 4, 7} {
			var buf bytes.Buffer
			w := NewWriter(&buf)
			p, err := w.Grid(gridSpec(1, 2, n), Coverage{})
			mustOK(t, err)
			total := rows
			if rows > 1 {
				total = rows + 1 // the first batch is 1 series
			}
			for i := 0; i < total; i++ {
				s := rampSeries(i, n)
				if i%2 == 1 {
					s.Present[0] = false
				}
				mustOK(t, p.Add(s))
			}
			mustOK(t, p.Finish(Coverage{Phase: PhaseFinal}))
			mustOK(t, w.End())
			if got := dataBatchRows(t, buf.Bytes(), 2); got[len(got)-1] != rows {
				t.Errorf("batches %v, want a last batch of %d", got, rows)
			}
			checkAlignment(t, "grid", buf.Bytes())
		}
	}
}
