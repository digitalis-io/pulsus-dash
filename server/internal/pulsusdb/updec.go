package pulsusdb

import "io"

// tokenKind is the kind of a JSON token.
type tokenKind int

// The token kinds.
const (
	tokEOF tokenKind = iota
	tokObjStart
	tokObjEnd
	tokArrStart
	tokArrEnd
	tokKey
	tokString
	tokNumber
	tokBool
	tokNull
)

// upstreamDecoder is the only decoder of upstream bodies (§4.9).
type upstreamDecoder struct {
	red redactor
	r   io.Reader
}

func newUpstreamDecoder(r io.Reader, red redactor) *upstreamDecoder {
	return &upstreamDecoder{red: red, r: r}
}

func (d *upstreamDecoder) Next() (tokenKind, error) { return tokEOF, nil }
func (d *upstreamDecoder) String() string           { return "" }
func (d *upstreamDecoder) Number() (string, error)  { return "", nil }
func (d *upstreamDecoder) Sample() (float64, error) { return 0, nil }
func (d *upstreamDecoder) Bool() bool               { return false }
func (d *upstreamDecoder) Skip() error              { return nil }
