package gateway

import (
	"encoding/base64"
	"encoding/binary"
	"errors"
	"regexp"

	"github.com/digitalis-io/pulsus-dash/server/internal/keyhash"
	"github.com/digitalis-io/pulsus-dash/server/internal/pulsusdb"
)

// cursorPattern is the wire form of a cursor: 36 bytes in unpadded base64url.
var cursorPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{48}$`)

// cursorVersion is the first byte of a cursor image; cursorBytes its length.
const (
	cursorVersion = 1
	cursorBytes   = 36
)

// logCursor continues a log page (plan #65 Part B §3.1). It binds the page cursor to the request
// it continues: the query (by hash), the direction and the request's from and to (not the grid).
// It is opaque and unsigned: it carries no tenant and authorises nothing, so a forged cursor can
// only narrow the caller's own window inside its own tenant.
type logCursor struct {
	Dir       pulsusdb.Direction
	QueryHash uint64 // keyhash.Text(query)
	FromMs    int64
	ToMs      int64
	At        pulsusdb.PageCursor
}

var errCursor = errors.New("gateway: invalid cursor")

// encodeCursor is base64.RawURLEncoding of the 36-byte big-endian image: version 1, dir (0
// backward, 1 forward), QueryHash, FromMs, ToMs, At.TsNs and At.Skip (uint16).
func encodeCursor(c logCursor) string {
	var b [cursorBytes]byte
	b[0] = cursorVersion
	if c.Dir == pulsusdb.Forward {
		b[1] = 1
	}
	binary.BigEndian.PutUint64(b[2:], c.QueryHash)
	binary.BigEndian.PutUint64(b[10:], uint64(c.FromMs))  // #nosec G115 -- a bit-for-bit image, decoded back to int64
	binary.BigEndian.PutUint64(b[18:], uint64(c.ToMs))    // #nosec G115 -- as above
	binary.BigEndian.PutUint64(b[26:], uint64(c.At.TsNs)) // #nosec G115 -- as above
	binary.BigEndian.PutUint16(b[34:], uint16(c.At.Skip)) // #nosec G115 -- Skip is 0..4 999
	return base64.RawURLEncoding.EncodeToString(b[:])
}

// decodeCursor refuses anything but unpadded base64url of exactly 36 bytes, a version other than
// 1, a dir above 1 and a Skip above 4 999.
func decodeCursor(s string) (logCursor, error) {
	b, err := base64.RawURLEncoding.Strict().DecodeString(s)
	if err != nil || len(b) != cursorBytes || b[0] != cursorVersion || b[1] > 1 {
		return logCursor{}, errCursor
	}
	skip := int(binary.BigEndian.Uint16(b[34:]))
	if skip >= pulsusdb.MaxLogLimit {
		return logCursor{}, errCursor
	}
	return logCursor{
		Dir:       pulsusdb.Direction(b[1]),
		QueryHash: binary.BigEndian.Uint64(b[2:]),
		FromMs:    int64(binary.BigEndian.Uint64(b[10:])),                                        // #nosec G115 -- the image of an int64
		ToMs:      int64(binary.BigEndian.Uint64(b[18:])),                                        // #nosec G115 -- as above
		At:        pulsusdb.PageCursor{TsNs: int64(binary.BigEndian.Uint64(b[26:])), Skip: skip}, // #nosec G115 -- as above
	}, nil
}

// cursorAfter decodes the cursor s of a request and checks it: it must decode, and its At.TsNs
// must lie in its own window (FromMs·10⁶, ToMs·10⁶] (else /cursor cursor.invalid); it must have
// been issued for this query, direction, from and to (else /cursor cursor.mismatch). The width is
// not bound: it does not change which entries a page holds.
func cursorAfter(s string, dir pulsusdb.Direction, query string, fromMs, toMs int64) (*pulsusdb.PageCursor, *reqError) {
	c, err := decodeCursor(s)
	// FromMs and ToMs are bounded before they are scaled, so the products cannot overflow.
	if err != nil || c.FromMs < 0 || c.ToMs > maxLogTimeMs || c.FromMs >= c.ToMs ||
		c.At.TsNs <= c.FromMs*1_000_000 || c.At.TsNs > c.ToMs*1_000_000 {
		return nil, fieldError("/cursor", "cursor.invalid", "cursor is not a cursor of this route")
	}
	if c.Dir != dir || c.QueryHash != keyhash.Text(query) || c.FromMs != fromMs || c.ToMs != toMs {
		return nil, fieldError("/cursor", "cursor.mismatch", "cursor belongs to another query, direction or time range")
	}
	at := c.At
	return &at, nil
}
