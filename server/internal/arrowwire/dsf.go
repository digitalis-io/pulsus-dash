// Package arrowwire writes query results as Arrow IPC messages in Dash Stream Frames (DSF, T04
// §5.1; plan #68 Part B1). It turns the pulsusdb.Series the BFF already decodes into the
// labels/1 and metric_matrix.grid/1 schemas of wire/schemas, with coverage/1 and error/1
// metadata frames. One goroutine owns a Writer and its GridParts.
package arrowwire

import (
	"errors"
	"io"
)

// ContentType is the media type of a DSF response body.
const ContentType = "application/vnd.pulsus.dash-stream;v=1"

// HeaderLen is the DSF header length; MaxPayload bounds one frame's payload.
const HeaderLen, MaxPayload = 16, 64 << 20

// FrameType is a DSF frame type (T04 §5.1).
type FrameType uint8

// The frame types.
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
	FlagLast uint16 = 1 << iota
	FlagVolatile
	FlagCached
)

// Header is a DSF frame header.
type Header struct {
	Type               FrameType
	Flags              uint16
	PartID, PayloadLen uint32
	Rank               uint16
}

var errNotImplemented = errors.New("arrowwire: not implemented")

// Errors.
var (
	ErrShape         = errors.New("arrowwire: shape")
	ErrOrder         = errors.New("arrowwire: order")
	ErrFrameTooLarge = errors.New("arrowwire: frame too large")
	ErrHeader        = errors.New("arrowwire: bad header")
)

// AppendHeader appends the 16-byte header h to b.
func AppendHeader(b []byte, h Header) []byte { return b }

// ParseHeader parses the header at the start of b.
func ParseHeader(b []byte) (Header, error) { return Header{}, errNotImplemented }

// Writer writes one DSF response body.
type Writer struct{ w io.Writer }

// NewWriter returns a Writer on w.
func NewWriter(w io.Writer) *Writer { return &Writer{w: w} }

// End writes END.
func (w *Writer) End() error { return errNotImplemented }

// Error writes ERROR|LAST for a part never opened.
func (w *Writer) Error(part uint32, rank uint16, e ErrorRow) error { return errNotImplemented }
