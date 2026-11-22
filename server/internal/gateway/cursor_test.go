package gateway

import (
	"encoding/base64"
	"encoding/binary"
	"testing"

	"github.com/digitalis-io/pulsus-dash/server/internal/keyhash"
	"github.com/digitalis-io/pulsus-dash/server/internal/pulsusdb"
)

const (
	curFrom  = int64(1767225600000)
	curTo    = int64(1767229200000)
	curQuery = `{app="x"}`
	curTs300 = int64(1767229100000000300)
)

// unit:log-cursor (plan #65 Part B §3.1): the 36-byte image, its refusals and the request binding.
func TestLogCursor(t *testing.T) {
	h := keyhash.Text(curQuery)
	for _, c := range []logCursor{
		{Dir: pulsusdb.Backward, QueryHash: h, FromMs: curFrom, ToMs: curTo, At: pulsusdb.PageCursor{TsNs: curTs300}},
		{Dir: pulsusdb.Forward, QueryHash: h, FromMs: curFrom, ToMs: curTo, At: pulsusdb.PageCursor{TsNs: curTs300, Skip: 4999}},
	} {
		s := encodeCursor(c)
		if len(s) != 48 || !cursorPattern.MatchString(s) {
			t.Errorf("encodeCursor(%+v) = %q (%d characters), want 48 base64url characters", c, s, len(s))
		}
		got, err := decodeCursor(s)
		if err != nil || got != c {
			t.Errorf("decodeCursor(encodeCursor(%+v)) = %+v, %v", c, got, err)
		}
		at, e := cursorAfter(s, c.Dir, curQuery, curFrom, curTo)
		if e != nil || at == nil || *at != c.At {
			t.Errorf("cursorAfter(%+v) = %v, %+v; want %+v", c, at, e, c.At)
		}
	}

	valid := logCursor{Dir: pulsusdb.Backward, QueryHash: h, FromMs: curFrom, ToMs: curTo, At: pulsusdb.PageCursor{TsNs: curTs300}}
	image := func() []byte {
		b, err := base64.RawURLEncoding.DecodeString(encodeCursor(valid))
		if err != nil || len(b) != 36 {
			// The encoding is checked above; the refusals below need a 36-byte image to edit.
			b = make([]byte, 36)
			b[0] = 1
			binary.BigEndian.PutUint64(b[2:], h)
			binary.BigEndian.PutUint64(b[10:], uint64(curFrom))
			binary.BigEndian.PutUint64(b[18:], uint64(curTo))
			binary.BigEndian.PutUint64(b[26:], uint64(curTs300))
		}
		return b
	}
	enc := func(b []byte) string { return base64.RawURLEncoding.EncodeToString(b) }
	edit := func(f func(b []byte) []byte) string { return enc(f(image())) }
	invalid := map[string]string{
		"35 bytes":            edit(func(b []byte) []byte { return b[:35] }),
		"37 bytes":            edit(func(b []byte) []byte { return append(b, 0) }),
		"version 2":           edit(func(b []byte) []byte { b[0] = 2; return b }),
		"dir 2":               edit(func(b []byte) []byte { b[1] = 2; return b }),
		"skip 5000":           edit(func(b []byte) []byte { binary.BigEndian.PutUint16(b[34:], 5000); return b }),
		"ts at from":          edit(func(b []byte) []byte { binary.BigEndian.PutUint64(b[26:], uint64(curFrom*1_000_000)); return b }),
		"ts beyond to":        edit(func(b []byte) []byte { binary.BigEndian.PutUint64(b[26:], uint64(curTo*1_000_000+1)); return b }),
		"not base64url":       "!" + enc(image())[1:],
		"padded":              enc(image())[:46] + "==",
		"empty":               "",
		"standard alphabet +": "+" + enc(image())[1:],
	}
	for name, s := range invalid {
		if _, e := cursorAfter(s, pulsusdb.Backward, curQuery, curFrom, curTo); !wantCursorError(e, "cursor.invalid") {
			t.Errorf("%s: cursorAfter = %+v, want /cursor cursor.invalid", name, e)
		}
	}
	for _, name := range []string{"35 bytes", "37 bytes", "version 2", "dir 2", "skip 5000"} {
		if _, err := decodeCursor(invalid[name]); err == nil {
			t.Errorf("%s: decodeCursor accepted it", name)
		}
	}

	s := encodeCursor(valid)
	for name, c := range map[string]struct {
		dir      pulsusdb.Direction
		query    string
		from, to int64
	}{
		"query":     {pulsusdb.Backward, `{app="y"}`, curFrom, curTo},
		"direction": {pulsusdb.Forward, curQuery, curFrom, curTo},
		"from":      {pulsusdb.Backward, curQuery, curFrom + 1, curTo},
		"to":        {pulsusdb.Backward, curQuery, curFrom, curTo + 1},
	} {
		if _, e := cursorAfter(s, c.dir, c.query, c.from, c.to); !wantCursorError(e, "cursor.mismatch") {
			t.Errorf("another %s: cursorAfter = %+v, want /cursor cursor.mismatch", name, e)
		}
	}
}

func wantCursorError(e *reqError, key string) bool {
	return e != nil && e.status == 400 && e.body.Fields != nil && len(*e.body.Fields) == 1 &&
		(*e.body.Fields)[0].Pointer == "/cursor" && (*e.body.Fields)[0].MessageKey == key
}
