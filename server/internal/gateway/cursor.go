package gateway

import (
	"errors"
	"regexp"

	"github.com/digitalis-io/pulsus-dash/server/internal/pulsusdb"
)

// cursorPattern is the wire form of a cursor.
var cursorPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{48}$`)

// logCursor continues a log page (stub).
type logCursor struct {
	Dir       pulsusdb.Direction
	QueryHash uint64
	FromMs    int64
	ToMs      int64
	At        pulsusdb.PageCursor
}

func encodeCursor(logCursor) string { return "" }

func decodeCursor(string) (logCursor, error) { return logCursor{}, errors.New("not implemented") }

func cursorAfter(string, pulsusdb.Direction, string, int64, int64) (*pulsusdb.PageCursor, *reqError) {
	return nil, nil
}
