package gateway

import (
	"strconv"

	"github.com/digitalis-io/pulsus-dash/server/internal/keyhash"
	"github.com/digitalis-io/pulsus-dash/server/internal/pulsusdb"
)

// The JSON image of a log page (plan #65 Part B §3.4; T04 §4.3 log_lines/1, ADR-0014 §5). Key order
// is fixed, with no whitespace and the string encoding of frames.go:
//
//	{"kind":"streams","start":…,"end":…,"step":…,"direction":…,"streams":[…],"cursor":…,"completeness":…}
//
// start and end are the request's from and to (the window (start, end] in ms) and step is the grid
// step. Streams keep LogPage.Streams order (key ascending); each stream's entries keep page order.
// A stream is {"key":…,"labels":…,"entries":[…]}; an entry is {"ts_ns":…,"line":…,"level":…}, then
// "metadata" and "parsed" when the entry has any. cursor is omitted when there is no further entry.

// appendLogPage appends the streams body of p. dataAgeMs < 0 omits data_age_ms.
func appendLogPage(b []byte, p *pulsusdb.LogPage, fromMs, toMs, stepMs int64, dir pulsusdb.Direction, cursor string, dataAgeMs int64) []byte {
	b = append(b, `{"kind":"streams","start":`...)
	b = strconv.AppendInt(b, fromMs, 10)
	b = append(b, `,"end":`...)
	b = strconv.AppendInt(b, toMs, 10)
	b = append(b, `,"step":`...)
	b = strconv.AppendInt(b, stepMs, 10)
	b = append(b, `,"direction":"`...)
	b = append(b, dir.String()...)
	b = append(b, `","streams":[`...)
	// Group the entries by stream, keeping page order within each (a stable counting sort).
	start := make([]int, len(p.Streams)+1)
	for _, e := range p.Entries {
		start[e.Stream+1]++
	}
	for i := 1; i < len(start); i++ {
		start[i] += start[i-1]
	}
	next := append([]int(nil), start[:len(p.Streams)]...)
	order := make([]int, len(p.Entries))
	for i, e := range p.Entries {
		order[next[e.Stream]] = i
		next[e.Stream]++
	}
	for si, s := range p.Streams {
		if si > 0 {
			b = append(b, ',')
		}
		b = append(b, `{"key":"`...)
		b = append(b, keyhash.Hex(s.Key)...)
		b = append(b, `","labels":`...)
		b = appendLabels(b, s.Labels)
		b = append(b, `,"entries":[`...)
		for j, i := range order[start[si]:start[si+1]] {
			if j > 0 {
				b = append(b, ',')
			}
			b = appendLogEntry(b, &p.Entries[i])
		}
		b = append(b, "]}"...)
	}
	b = append(b, ']')
	if cursor != "" {
		b = append(b, `,"cursor":"`...)
		b = append(b, cursor...) // base64url: no escaping needed
		b = append(b, '"')
	}
	b = append(b, `,"completeness":`...)
	b = appendCompleteness(b, p.Completeness, dataAgeMs)
	return append(b, '}')
}

// appendLogEntry appends {"ts_ns":"<decimal>","line":…,"level":…[,"metadata":…][,"parsed":…]}.
func appendLogEntry(b []byte, e *pulsusdb.LogEntry) []byte {
	b = append(b, `{"ts_ns":"`...)
	b = strconv.AppendInt(b, e.TsNs, 10)
	b = append(b, `","line":`...)
	b = appendString(b, e.Line)
	b = append(b, `,"level":"`...)
	b = append(b, e.Level.String()...)
	b = append(b, '"')
	if len(e.Metadata) > 0 {
		b = append(b, `,"metadata":`...)
		b = appendLabels(b, e.Metadata)
	}
	if len(e.Parsed) > 0 {
		b = append(b, `,"parsed":`...)
		b = appendLabels(b, e.Parsed)
	}
	return append(b, '}')
}
