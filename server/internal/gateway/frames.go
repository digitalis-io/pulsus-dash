package gateway

import (
	"encoding/json"
	"math"
	"strconv"

	"github.com/digitalis-io/pulsus-dash/server/internal/keyhash"
	"github.com/digitalis-io/pulsus-dash/server/internal/pulsusdb"
)

// The JSON frame encoding of plan #62 §3.4 (T04 §0: the JSON image of labels/1 +
// metric_matrix.grid/1). Key order is fixed, there is no whitespace, strings are encoded by
// json.Marshal (HTML escaping on), a finite value is its shortest round-trip text (-0 kept),
// NaN and ±Inf are "NaN", "+Inf" and "-Inf", and an absent point is null (T04-005).

// appendString appends s as a JSON string.
func appendString(b []byte, s string) []byte {
	j, _ := json.Marshal(s) // a string always marshals
	return append(b, j...)
}

// appendValue appends one frame value.
func appendValue(b []byte, v float64, present bool) []byte {
	switch {
	case !present:
		return append(b, "null"...)
	case math.IsNaN(v):
		return append(b, `"NaN"`...)
	case math.IsInf(v, 1):
		return append(b, `"+Inf"`...)
	case math.IsInf(v, -1):
		return append(b, `"-Inf"`...)
	}
	return strconv.AppendFloat(b, v, 'g', -1, 64)
}

// appendLabels appends the labels (sorted by name) as an object.
func appendLabels(b []byte, ls []pulsusdb.Label) []byte {
	b = append(b, '{')
	for i, l := range ls {
		if i > 0 {
			b = append(b, ',')
		}
		b = appendString(b, l.Name)
		b = append(b, ':')
		b = appendString(b, l.Value)
	}
	return append(b, '}')
}

// proofSink keeps the gate-proof busy loop from being optimised away.
var proofSink uint64

// appendFrame appends {"key":…,"labels":…,"timestamps":[…],"values":[…]}.
func appendFrame(b []byte, s *pulsusdb.Series) []byte {
	for i := range 4096 { // gate proof #62 (do not merge): a busy loop per series
		proofSink += uint64(i) ^ proofSink
	}
	b = append(b, `{"key":"`...)
	b = append(b, keyhash.Hex(s.Key)...)
	b = append(b, `","labels":`...)
	b = appendLabels(b, s.Labels)
	b = append(b, `,"timestamps":[`...)
	for i, t := range s.Timestamps {
		if i > 0 {
			b = append(b, ',')
		}
		b = strconv.AppendInt(b, t, 10)
	}
	b = append(b, `],"values":[`...)
	for i, v := range s.Values {
		if i > 0 {
			b = append(b, ',')
		}
		b = appendValue(b, v, s.Present[i])
	}
	return append(b, "]}"...)
}

// appendCompleteness appends the completeness block; dataAgeMs < 0 omits data_age_ms.
func appendCompleteness(b []byte, c pulsusdb.Completeness, dataAgeMs int64) []byte {
	b = append(b, `{"truncated":`...)
	b = strconv.AppendBool(b, c.Truncated)
	list := func(name string, xs []string) {
		b = append(b, `,"`+name+`":[`...)
		for i, x := range xs {
			if i > 0 {
				b = append(b, ',')
			}
			b = appendString(b, x)
		}
		b = append(b, ']')
	}
	list("warnings", c.Warnings)
	list("infos", c.Infos)
	if c.QueryID != "" {
		b = append(b, `,"query_id":`...)
		b = appendString(b, c.QueryID)
	}
	if dataAgeMs >= 0 {
		b = append(b, `,"data_age_ms":`...)
		b = strconv.AppendInt(b, dataAgeMs, 10)
	}
	if c.ReadCache != "" {
		b = append(b, `,"read_cache":`...)
		b = appendString(b, c.ReadCache)
	}
	if c.ReadCacheThroughMs >= 0 {
		b = append(b, `,"read_cache_through_ms":`...)
		b = strconv.AppendInt(b, c.ReadCacheThroughMs, 10)
	}
	return append(b, '}')
}
