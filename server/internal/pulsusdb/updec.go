package pulsusdb

import (
	"bufio"
	"errors"
	"io"
	"strconv"
	"unicode/utf16"
	"unicode/utf8"
)

// upstreamDecoder is the only code that reads PulsusDB body bytes (§4.9): a streaming JSON
// tokenizer over a bufio.Reader, with no reflection and no encoding/json. Every key and string
// token is returned through redact; a sample value is only ever parsed as a float.
//
// Next advances to the next token and returns its kind. String returns the current key or string
// token, decoded (escapes and surrogate pairs resolved, invalid UTF-8 and lone surrogates →
// U+FFFD) and redacted. Number returns the current number token's text. Sample parses the current
// string token as a float64. Bool returns the current boolean. Skip, after an object or array
// start, skips to its end. Syntax errors are *Error of KindProtocol; read errors are returned as
// they are and stick.
type upstreamDecoder struct {
	r     *bufio.Reader
	red   redactor
	stack []byte // '{' or '['
	state decState
	kind  tokenKind
	buf   []byte // the current string (decoded) or number token
	b     bool
	err   error
}

// tokenKind is the kind of a JSON token.
type tokenKind int

// The token kinds; tokEOF follows the top-level value.
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

type decState uint8

const (
	stValue    decState = iota // a value is expected
	stArrFirst                 // after '[': a value or ']'
	stObjFirst                 // after '{': a key or '}'
	stObjKey                   // after ',' in an object: a key
	stAfter                    // after a value in a container: ',' or the close
	stDone                     // the top-level value is complete
)

func newUpstreamDecoder(r io.Reader, red redactor) *upstreamDecoder {
	return &upstreamDecoder{r: bufio.NewReaderSize(r, 32<<10), red: red}
}

// Next returns the kind of the next token.
func (d *upstreamDecoder) Next() (tokenKind, error) {
	if d.err != nil {
		return tokEOF, d.err
	}
	k, err := d.next()
	if err != nil {
		d.err = err
		return tokEOF, err
	}
	d.kind = k
	return k, nil
}

// String is the current key or string token, redacted.
func (d *upstreamDecoder) String() string {
	if d.kind != tokKey && d.kind != tokString {
		return ""
	}
	return d.red.redact(string(d.buf))
}

// Number is the text of the current number token.
func (d *upstreamDecoder) Number() (string, error) {
	if d.kind != tokNumber {
		return "", protocolError()
	}
	return string(d.buf), nil
}

// Sample parses the current string token as a float64 (NaN, ±Inf, -0 and subnormals exactly).
// The token itself is never stored or returned; a token that is not a float is KindProtocol.
func (d *upstreamDecoder) Sample() (float64, error) {
	if d.kind != tokString {
		return 0, protocolError()
	}
	v, err := strconv.ParseFloat(string(d.buf), 64)
	if err != nil {
		return 0, protocolError()
	}
	return v, nil
}

// Bool is the current boolean token.
func (d *upstreamDecoder) Bool() bool { return d.kind == tokBool && d.b }

// Skip skips the rest of the value whose first token Next returned (a no-op for a scalar).
func (d *upstreamDecoder) Skip() error {
	if d.kind != tokObjStart && d.kind != tokArrStart {
		return d.err
	}
	for depth := 1; depth > 0; {
		k, err := d.Next()
		if err != nil {
			return err
		}
		switch k {
		case tokObjStart, tokArrStart:
			depth++
		case tokObjEnd, tokArrEnd:
			depth--
		}
	}
	return nil
}

// nonSpace returns the next byte that is not JSON whitespace.
func (d *upstreamDecoder) nonSpace() (byte, error) {
	for {
		c, err := d.r.ReadByte()
		if err != nil {
			return 0, err
		}
		if c != ' ' && c != '\t' && c != '\n' && c != '\r' {
			return c, nil
		}
	}
}

// eofIsSyntax turns a clean end of input inside a document into a syntax error.
func eofIsSyntax(err error) error {
	if errors.Is(err, io.EOF) {
		return protocolError()
	}
	return err
}

func (d *upstreamDecoder) afterValue() {
	if len(d.stack) == 0 {
		d.state = stDone
	} else {
		d.state = stAfter
	}
}

func (d *upstreamDecoder) next() (tokenKind, error) {
	c, err := d.nonSpace()
	if d.state == stDone {
		if errors.Is(err, io.EOF) {
			return tokEOF, nil
		}
		if err != nil {
			return tokEOF, err
		}
		return tokEOF, protocolError()
	}
	if err != nil {
		return tokEOF, eofIsSyntax(err)
	}
	if d.state == stAfter {
		top := d.stack[len(d.stack)-1]
		switch {
		case c == ',' && top == '{':
			d.state = stObjKey
		case c == ',':
			d.state = stValue
		case (c == '}' && top == '{') || (c == ']' && top == '['):
			d.stack = d.stack[:len(d.stack)-1]
			d.afterValue()
			if c == '}' {
				return tokObjEnd, nil
			}
			return tokArrEnd, nil
		default:
			return tokEOF, protocolError()
		}
		if c, err = d.nonSpace(); err != nil {
			return tokEOF, eofIsSyntax(err)
		}
	}
	switch d.state {
	case stObjFirst, stObjKey:
		if c == '}' && d.state == stObjFirst {
			d.stack = d.stack[:len(d.stack)-1]
			d.afterValue()
			return tokObjEnd, nil
		}
		if c != '"' {
			return tokEOF, protocolError()
		}
		if err := d.readString(); err != nil {
			return tokEOF, err
		}
		colon, err := d.nonSpace()
		if err != nil {
			return tokEOF, eofIsSyntax(err)
		}
		if colon != ':' {
			return tokEOF, protocolError()
		}
		d.state = stValue
		return tokKey, nil
	case stArrFirst:
		if c == ']' {
			d.stack = d.stack[:len(d.stack)-1]
			d.afterValue()
			return tokArrEnd, nil
		}
	}
	return d.value(c)
}

// value reads the value starting with c.
func (d *upstreamDecoder) value(c byte) (tokenKind, error) {
	switch {
	case c == '{':
		d.stack = append(d.stack, '{')
		d.state = stObjFirst
		return tokObjStart, nil
	case c == '[':
		d.stack = append(d.stack, '[')
		d.state = stArrFirst
		return tokArrStart, nil
	case c == '"':
		if err := d.readString(); err != nil {
			return tokEOF, err
		}
		d.afterValue()
		return tokString, nil
	case c == 't' || c == 'f' || c == 'n':
		word := map[byte]string{'t': "rue", 'f': "alse", 'n': "ull"}[c]
		for i := 0; i < len(word); i++ {
			b, err := d.r.ReadByte()
			if err != nil {
				return tokEOF, eofIsSyntax(err)
			}
			if b != word[i] {
				return tokEOF, protocolError()
			}
		}
		d.afterValue()
		if c == 'n' {
			return tokNull, nil
		}
		d.b = c == 't'
		return tokBool, nil
	case c == '-' || (c >= '0' && c <= '9'):
		if err := d.readNumber(c); err != nil {
			return tokEOF, err
		}
		d.afterValue()
		return tokNumber, nil
	}
	return tokEOF, protocolError()
}

// readNumber reads a number token (c is its first byte) into buf: the run of number bytes is
// copied from the buffered window, then checked against the JSON grammar. The byte after the
// number stays unread.
func (d *upstreamDecoder) readNumber(c byte) error {
	d.buf = append(d.buf[:0], c)
	for {
		win, _ := d.r.Peek(d.r.Buffered())
		i := 0
		for i < len(win) && numberByte(win[i]) {
			i++
		}
		d.buf = append(d.buf, win[:i]...)
		_, _ = d.r.Discard(i)
		if i < len(win) {
			break
		}
		if _, err := d.r.Peek(1); err != nil {
			if errors.Is(err, io.EOF) {
				break
			}
			return err
		}
	}
	if !validNumber(d.buf) {
		return protocolError()
	}
	return nil
}

func numberByte(c byte) bool {
	return (c >= '0' && c <= '9') || c == '.' || c == 'e' || c == 'E' || c == '+' || c == '-'
}

// validNumber reports whether b is -?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?.
func validNumber(b []byte) bool {
	i := 0
	digits := func() int {
		n := 0
		for i < len(b) && b[i] >= '0' && b[i] <= '9' {
			i++
			n++
		}
		return n
	}
	if i < len(b) && b[i] == '-' {
		i++
	}
	switch {
	case i < len(b) && b[i] == '0':
		i++
	case digits() == 0:
		return false
	}
	if i < len(b) && b[i] == '.' {
		i++
		if digits() == 0 {
			return false
		}
	}
	if i < len(b) && (b[i] == 'e' || b[i] == 'E') {
		i++
		if i < len(b) && (b[i] == '+' || b[i] == '-') {
			i++
		}
		if digits() == 0 {
			return false
		}
	}
	return i == len(b)
}

// numberBytes is the current number token's text, valid until the next call to Next.
func (d *upstreamDecoder) numberBytes() ([]byte, bool) {
	return d.buf, d.kind == tokNumber
}

// readString reads a string token (the opening quote was read) into buf, decoded. Runs without
// escapes are copied from the buffered window.
func (d *upstreamDecoder) readString() error {
	d.buf = d.buf[:0]
	ascii := true
	for {
		win, _ := d.r.Peek(d.r.Buffered())
		i := 0
		for i < len(win) {
			c := win[i]
			if c == '"' || c == '\\' || c < 0x20 {
				break
			}
			if c >= utf8.RuneSelf {
				ascii = false
			}
			i++
		}
		d.buf = append(d.buf, win[:i]...)
		_, _ = d.r.Discard(i)
		if i == len(win) {
			if _, err := d.r.Peek(1); err != nil {
				return eofIsSyntax(err)
			}
			continue
		}
		c, _ := d.r.ReadByte()
		switch {
		case c == '"':
			if !ascii && !utf8.Valid(d.buf) {
				d.buf = []byte(toValidUTF8(d.buf))
			}
			return nil
		case c < 0x20:
			return protocolError()
		default: // a backslash
			if err := d.readEscape(); err != nil {
				return err
			}
			ascii = false // an escape may produce non-ASCII bytes; checked once at the end
		}
	}
}

func (d *upstreamDecoder) readEscape() error {
	c, err := d.r.ReadByte()
	if err != nil {
		return eofIsSyntax(err)
	}
	switch c {
	case '"', '\\', '/':
		d.buf = append(d.buf, c)
	case 'b':
		d.buf = append(d.buf, '\b')
	case 'f':
		d.buf = append(d.buf, '\f')
	case 'n':
		d.buf = append(d.buf, '\n')
	case 'r':
		d.buf = append(d.buf, '\r')
	case 't':
		d.buf = append(d.buf, '\t')
	case 'u':
		r, err := d.hex4()
		if err != nil {
			return err
		}
		if utf16.IsSurrogate(r) {
			if p, _ := d.r.Peek(2); len(p) == 2 && p[0] == '\\' && p[1] == 'u' {
				_, _ = d.r.Discard(2)
				r2, err := d.hex4()
				if err != nil {
					return err
				}
				if dec := utf16.DecodeRune(r, r2); dec != utf8.RuneError {
					d.buf = utf8.AppendRune(d.buf, dec)
					return nil
				}
				d.buf = utf8.AppendRune(d.buf, utf8.RuneError)
				if utf16.IsSurrogate(r2) {
					r2 = utf8.RuneError
				}
				d.buf = utf8.AppendRune(d.buf, r2)
				return nil
			}
			r = utf8.RuneError
		}
		d.buf = utf8.AppendRune(d.buf, r)
	default:
		return protocolError()
	}
	return nil
}

func (d *upstreamDecoder) hex4() (rune, error) {
	var r rune
	for range 4 {
		c, err := d.r.ReadByte()
		if err != nil {
			return 0, eofIsSyntax(err)
		}
		switch {
		case c >= '0' && c <= '9':
			r = r<<4 | rune(c-'0')
		case c >= 'a' && c <= 'f':
			r = r<<4 | rune(c-'a'+10)
		case c >= 'A' && c <= 'F':
			r = r<<4 | rune(c-'A'+10)
		default:
			return 0, protocolError()
		}
	}
	return r, nil
}

// toValidUTF8 replaces each invalid byte with U+FFFD, as RFC 8259 decoders do.
func toValidUTF8(b []byte) string {
	out := make([]byte, 0, len(b)+8)
	for len(b) > 0 {
		r, n := utf8.DecodeRune(b)
		if r == utf8.RuneError && n == 1 {
			out = utf8.AppendRune(out, utf8.RuneError)
		} else {
			out = append(out, b[:n]...)
		}
		b = b[n:]
	}
	return string(out)
}

// errTooLarge is returned by capReader past its limit.
var errTooLarge = errors.New("pulsusdb: body over its limit")

// capReader reads at most limit bytes and returns errTooLarge if the body has more.
type capReader struct {
	r    io.Reader
	left int64
}

func (c *capReader) Read(p []byte) (int, error) {
	if c.left <= 0 {
		var one [1]byte
		n, err := c.r.Read(one[:])
		if n > 0 {
			return 0, errTooLarge
		}
		return 0, err
	}
	if int64(len(p)) > c.left {
		p = p[:c.left]
	}
	n, err := c.r.Read(p)
	c.left -= int64(n)
	return n, err
}
