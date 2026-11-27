// Package arrowwire writes query results as Arrow IPC messages in Dash Stream Frames (DSF, T04
// §5.1; plan #68 Part B1). It turns the pulsusdb.Series the BFF already decodes into the
// labels/1 and metric_matrix.grid/1 schemas of wire/schemas, with coverage/1 and error/1
// metadata frames. One goroutine owns a Writer and its GridParts; nothing here is safe for
// concurrent use.
package arrowwire

import (
	"encoding/binary"
	"errors"
	"fmt"
	"io"

	"github.com/apache/arrow-go/v18/arrow"
	"github.com/apache/arrow-go/v18/arrow/ipc"
	"github.com/apache/arrow-go/v18/arrow/memory"
)

// ContentType is the media type of a DSF response body.
const ContentType = "application/vnd.pulsus.dash-stream;v=1"

// HeaderLen is the DSF header length; MaxPayload bounds one frame's payload (64 MiB).
const HeaderLen, MaxPayload = 16, 64 << 20

// version is the DSF version written and accepted.
const version = 1

// FrameType is a DSF frame type (T04 §5.1).
type FrameType uint8

// The frame types, in T04 §5.1 order.
const (
	FrameSchema FrameType = 1 + iota
	FrameBatch
	FrameMeta
	FrameEnd
	FrameError
	FrameProgress
	FrameEvent
	FramePing
)

// The header flags.
const (
	FlagLast     uint16 = 1 << iota // last frame of its part
	FlagVolatile                    // the part touches "now"
	FlagCached                      // served from the BFF cache
)

// Header is a DSF frame header.
type Header struct {
	Type               FrameType
	Flags              uint16
	PartID, PayloadLen uint32
	Rank               uint16
}

// Errors. ErrShape: an input the schemas cannot carry (bad grid, part id, series length).
// ErrOrder: a call after its part closed, after the stream-level refusal or after END.
// ErrFrameTooLarge: a frame payload above MaxPayload. ErrHeader: a malformed header.
var (
	ErrShape         = errors.New("arrowwire: shape")
	ErrOrder         = errors.New("arrowwire: order")
	ErrFrameTooLarge = errors.New("arrowwire: frame too large")
	ErrHeader        = errors.New("arrowwire: bad header")
)

// AppendHeader appends the 16-byte little-endian header h to b.
func AppendHeader(b []byte, h Header) []byte {
	b = append(b, version, byte(h.Type))
	b = binary.LittleEndian.AppendUint16(b, h.Flags)
	b = binary.LittleEndian.AppendUint32(b, h.PartID)
	b = binary.LittleEndian.AppendUint32(b, h.PayloadLen)
	b = binary.LittleEndian.AppendUint16(b, h.Rank)
	return binary.LittleEndian.AppendUint16(b, 0)
}

// ParseHeader parses the header at the start of b: version 1, a known type, reserved 0
// (else ErrHeader) and a payload of at most MaxPayload (else ErrFrameTooLarge).
func ParseHeader(b []byte) (Header, error) {
	if len(b) < HeaderLen {
		return Header{}, fmt.Errorf("%w: %d bytes", ErrHeader, len(b))
	}
	if b[0] != version {
		return Header{}, fmt.Errorf("%w: version %d", ErrHeader, b[0])
	}
	h := Header{Type: FrameType(b[1]), Flags: binary.LittleEndian.Uint16(b[2:]), PartID: binary.LittleEndian.Uint32(b[4:]),
		PayloadLen: binary.LittleEndian.Uint32(b[8:]), Rank: binary.LittleEndian.Uint16(b[12:])}
	if h.Type < FrameSchema || h.Type > FramePing {
		return Header{}, fmt.Errorf("%w: type %d", ErrHeader, h.Type)
	}
	if r := binary.LittleEndian.Uint16(b[14:]); r != 0 {
		return Header{}, fmt.Errorf("%w: reserved %#x", ErrHeader, r)
	}
	if h.PayloadLen > MaxPayload {
		return Header{}, fmt.Errorf("%w: payload %d", ErrFrameTooLarge, h.PayloadLen)
	}
	return h, nil
}

// mem allocates the arrays and payloads of this package.
var mem = memory.NewGoAllocator()

// eos is the IPC end-of-stream marker that ends META and ERROR payloads.
var eos = []byte{0xFF, 0xFF, 0xFF, 0xFF, 0, 0, 0, 0}

// Writer writes one DSF response body. It keeps the body offset (for alignment), the part ids
// used, whether the stream-level ERROR and END were written, and the §3.1 accounting of its
// limits (plan #68 B3); an io.Writer error is sticky.
type Writer struct {
	w        io.Writer
	off      int64
	err      error
	refused  bool
	ended    bool
	used     map[uint32]bool
	lim      Limits
	open     int  // open parts (two per open GridPart)
	openData int  // open data parts (each keeps a part_reserve)
	spent    int  // body budget used (§3.1 accounting)
	values   int  // value budget used
	noBudget bool // test knob: both budget checks off (budget-over.dsf)
}

// NewWriter returns a Writer on w with DefaultLimits; the body starts at offset 0.
func NewWriter(w io.Writer) *Writer { return NewWriterLimits(w, DefaultLimits()) }

// End writes END (part 0, rank 0, no flags). Parts still open stay open; the reader fails them.
func (w *Writer) End() error {
	if w.err != nil {
		return w.err
	}
	if w.ended {
		return ErrOrder
	}
	f := w.frames()
	if err := f.add(Header{Type: FrameEnd}, nil); err != nil {
		return err
	}
	w.ended = true
	return f.commit()
}

// Error writes ERROR|LAST for a part never opened. A zero or already used part id is ErrShape,
// a payload above MaxPayload ErrFrameTooLarge, and a call past open_parts, distinct_parts or the
// body budget (with all reserves) ErrLimit; each writes the stream-level ERROR instead (outcome
// (a) of the refusal contract), after which every Grid and Error is ErrOrder. Message and
// suggestion are cut to meta_string_bytes (B3 §3.1).
func (w *Writer) Error(part uint32, rank uint16, e ErrorRow) error {
	if err := w.callable(); err != nil {
		return err
	}
	if part == 0 || w.used[part] {
		return w.refuse(ErrShape)
	}
	e = cutError(e, w.lim)
	charge := costPart + errorCost(e)
	if !w.admit(1, charge, w.openData) {
		return w.refuse(ErrLimit)
	}
	f := w.frames()
	if err := f.add(Header{Type: FrameError, Flags: FlagLast, PartID: part, Rank: rank}, errorPayload(e)); err != nil {
		return w.refuse(err)
	}
	w.used[part] = true
	if err := f.commit(); err != nil {
		return err
	}
	w.spent += charge
	return nil
}

// callable is the precondition of Grid and Error.
func (w *Writer) callable() error {
	switch {
	case w.err != nil:
		return w.err
	case w.ended, w.refused:
		return ErrOrder
	}
	return nil
}

// refuse writes the stream-level ERROR (part 0, once per body: later calls are ErrOrder),
// charged from the stream reserve, and returns err.
func (w *Writer) refuse(err error) error {
	w.refused = true
	row := refusedRow("writer refused")
	f := w.frames()
	if ferr := f.add(Header{Type: FrameError, Flags: FlagLast}, errorPayload(row)); ferr != nil {
		return errors.Join(err, ferr)
	}
	if werr := f.commit(); werr != nil {
		return werr
	}
	w.spent += errorCost(row)
	return err
}

// refusedRow is the error/1 row of a writer refusal: code 8 internal.
func refusedRow(msg string) ErrorRow { return ErrorRow{Code: 8, HTTPStatus: 500, Message: msg} }

// frameSet builds frames in memory from the Writer's offset and writes them together, so a
// refusal found while building writes nothing.
type frameSet struct {
	w      *Writer
	off    int64
	frames [][]byte
}

func (w *Writer) frames() *frameSet { return &frameSet{w: w, off: w.off} }

// add builds one frame; build appends its payload (nil: an empty payload).
func (s *frameSet) add(h Header, build func(*payloadBuf) error) error {
	p := &payloadBuf{base: s.off, buf: make([]byte, HeaderLen, HeaderLen+256)}
	if build != nil {
		if err := build(p); err != nil {
			return err
		}
	}
	n := len(p.buf) - HeaderLen
	if n > MaxPayload {
		return ErrFrameTooLarge
	}
	h.PayloadLen = uint32(n) // #nosec G115 -- n ≤ MaxPayload, checked above
	AppendHeader(p.buf[:0], h)
	s.frames = append(s.frames, p.buf)
	s.off += int64(len(p.buf))
	return nil
}

// commit writes the frames; a write error is sticky for the Writer.
func (s *frameSet) commit() error {
	w := s.w
	if w.err != nil {
		return w.err
	}
	for _, f := range s.frames {
		n, err := w.w.Write(f)
		w.off += int64(n)
		if err == nil && n != len(f) {
			err = io.ErrShortWrite
		}
		if err != nil {
			w.err = fmt.Errorf("arrowwire: write: %w", err)
			return w.err
		}
	}
	s.frames = nil
	return nil
}

// payloadBuf is one frame in memory; base is the body offset of buf[0], the header. It is the
// ipc.PayloadWriter of META and ERROR payloads.
type payloadBuf struct {
	base int64
	buf  []byte
}

// Write appends b, refusing to grow the payload past MaxPayload.
func (p *payloadBuf) Write(b []byte) (int, error) {
	if len(p.buf)-HeaderLen+len(b) > MaxPayload {
		return 0, ErrFrameTooLarge
	}
	p.buf = append(p.buf, b...)
	return len(b), nil
}

// message appends one encapsulated IPC message (§3.2): FF FF FF FF, i32 L, the flatbuffer
// metadata zero-padded to L, then the body. L is the least multiple of 8 not below the
// metadata length that puts the body at a body offset ≡ 0 (mod 64).
func (p *payloadBuf) message(pl *ipc.Payload) error {
	meta := pl.Meta()
	if meta == nil {
		return errors.New("arrowwire: IPC payload without metadata")
	}
	defer meta.Release()
	ml := meta.Len()
	pos := p.base + int64(len(p.buf))
	l := (ml + 7) &^ 7
	for (pos+8+int64(l))%64 != 0 {
		l += 8
	}
	hdr := binary.LittleEndian.AppendUint32([]byte{0xFF, 0xFF, 0xFF, 0xFF}, uint32(l)) // #nosec G115 -- l < metadata + 64 ≤ MaxPayload
	for _, b := range [][]byte{hdr, meta.Bytes(), make([]byte, l-ml)} {
		if _, err := p.Write(b); err != nil {
			return err
		}
	}
	if err := pl.SerializeBody(p); err != nil {
		if errors.Is(err, ErrFrameTooLarge) {
			return ErrFrameTooLarge
		}
		return fmt.Errorf("arrowwire: IPC body: %w", err)
	}
	return nil
}

// Start is part of ipc.PayloadWriter.
func (p *payloadBuf) Start() error { return nil }

// WritePayload appends one payload of an ipc.Writer as one message.
func (p *payloadBuf) WritePayload(pl ipc.Payload) error { return p.message(&pl) }

// Close ends the stream with the EOS marker.
func (p *payloadBuf) Close() error {
	_, err := p.Write(eos)
	return err
}

// schemaPayload is a SCHEMA payload: the schema message alone.
func schemaPayload(s *arrow.Schema) func(*payloadBuf) error {
	return func(p *payloadBuf) error {
		pl := ipc.GetSchemaPayload(s, mem)
		defer pl.Release()
		return p.message(&pl)
	}
}

// batchPayload is a BATCH payload: the record batch message alone (v1 has no dictionaries).
func batchPayload(rec arrow.RecordBatch) func(*payloadBuf) error {
	return func(p *payloadBuf) error {
		pl, err := ipc.GetRecordBatchPayload(rec, ipc.WithAllocator(mem))
		if err != nil {
			return fmt.Errorf("arrowwire: record batch: %w", err)
		}
		defer pl.Release()
		return p.message(&pl)
	}
}

// streamPayload is a META or ERROR payload: a complete IPC stream of one one-row batch.
func streamPayload(rec arrow.RecordBatch) func(*payloadBuf) error {
	return func(p *payloadBuf) error {
		iw := ipc.NewWriterWithPayloadWriter(p, ipc.WithSchema(rec.Schema()), ipc.WithAllocator(mem))
		err := iw.Write(rec)
		if cerr := iw.Close(); err == nil {
			err = cerr
		}
		switch {
		case err == nil:
			return nil
		case errors.Is(err, ErrFrameTooLarge):
			return ErrFrameTooLarge
		default:
			return fmt.Errorf("arrowwire: metadata stream: %w", err)
		}
	}
}

// Err is the sticky io.Writer error, nil if none.
func (w *Writer) Err() error { return nil }
