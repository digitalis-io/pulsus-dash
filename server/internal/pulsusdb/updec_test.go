package pulsusdb

import (
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"math/rand/v2"
	"reflect"
	"strings"
	"testing"
)

const planted = "Zq9-planted-SECRET"

// reemit walks d with Next/String/Number/Bool and writes the document back.
func reemit(d *upstreamDecoder) (string, error) {
	type frame struct {
		obj, afterKey bool
		n             int
	}
	var b strings.Builder
	var st []frame
	pre := func() {
		if len(st) == 0 {
			return
		}
		top := &st[len(st)-1]
		if top.obj && top.afterKey {
			b.WriteByte(':')
			top.afterKey = false
			return
		}
		if top.n > 0 {
			b.WriteByte(',')
		}
		top.n++
	}
	str := func(s string) {
		j, _ := json.Marshal(s)
		b.Write(j)
	}
	for {
		k, err := d.Next()
		if err != nil {
			return "", err
		}
		switch k {
		case tokEOF:
			return b.String(), nil
		case tokObjStart, tokArrStart:
			pre()
			if k == tokObjStart {
				b.WriteByte('{')
			} else {
				b.WriteByte('[')
			}
			st = append(st, frame{obj: k == tokObjStart})
		case tokObjEnd, tokArrEnd:
			st = st[:len(st)-1]
			if k == tokObjEnd {
				b.WriteByte('}')
			} else {
				b.WriteByte(']')
			}
		case tokKey:
			pre()
			str(d.String())
			st[len(st)-1].afterKey = true
		case tokString:
			pre()
			str(d.String())
		case tokNumber:
			pre()
			n, err := d.Number()
			if err != nil {
				return "", err
			}
			b.WriteString(n)
		case tokBool:
			pre()
			fmt.Fprint(&b, d.Bool())
		case tokNull:
			pre()
			b.WriteString("null")
		}
	}
}

// generic decodes with encoding/json (tests only) and redacts the needle in every string.
func generic(t *testing.T, doc string, redact bool) any {
	t.Helper()
	dec := json.NewDecoder(strings.NewReader(doc))
	dec.UseNumber()
	var v any
	if err := dec.Decode(&v); err != nil {
		t.Fatalf("encoding/json rejects %q: %v", doc, err)
	}
	var walk func(any) any
	walk = func(v any) any {
		switch x := v.(type) {
		case string:
			if redact {
				return strings.ReplaceAll(x, planted, "<redacted>")
			}
			return x
		case []any:
			for i := range x {
				x[i] = walk(x[i])
			}
			return x
		case map[string]any:
			out := map[string]any{}
			for k, e := range x {
				kk := k
				if redact {
					kk = strings.ReplaceAll(k, planted, "<redacted>")
				}
				out[kk] = walk(e)
			}
			return out
		}
		return v
	}
	return walk(v)
}

func plantedRedactor() redactor { return needleRedactor(planted) }

var updecCorpus = []string{
	`null`, `true`, `false`, `0`, `-0`, `1e-7`, `1767225600.123`, `-12.5E+3`, `""`, `"plain"`,
	`[]`, `{}`, `[[]]`, `[{}]`, `{"a":{}}`, `{"a":[]}`, `[1,2,3]`, `{"a":1,"b":2}`, `{"b":2,"a":1}`,
	`{"":""}`, `"\u00e9\u2713"`, `"\ud83d\ude00"`, `"a\/b"`, `"\"\\\b\f\n\r\t"`, `"\u0041\u005a"`,
	`{"status":"success","data":{"resultType":"matrix","result":[]}}`,
	`{"data":{"result":[{"values":[[1767225600,"1"]],"metric":{"job":"api"}}],"resultType":"matrix"},"status":"success"}`,
	`[null,true,false,0,"x",[],{}]`, `{"a":{"b":{"c":{"d":[1,[2,[3]]]}}}}`,
	`"Zq9-planted-SECRET"`, `"xx Zq9-planted-SECRET yy"`, `{"Zq9-planted-SECRET":"v"}`, `{"k":"\u005Aq9-planted-SECRET"}`,
	`["Zq9-planted-SECRETZq9-planted-SECRET"]`, ` { "a" : [ 1 , 2 ] } `, "\n[\t1\r]\n", `[1e9,1E9,0.5,-1]`,
	`{"metric":{"__name__":"up"},"value":[1767229200,"NaN"]}`, `"héllo ✓"`, `[1767225600,"+Inf"]`,
}

// unit:updec (§4.9).
func TestUpdecRoundTrip(t *testing.T) {
	if len(updecCorpus) != 40 {
		t.Fatalf("corpus has %d documents, want 40", len(updecCorpus))
	}
	check := func(doc string) {
		t.Helper()
		got, err := reemit(newUpstreamDecoder(strings.NewReader(doc), plantedRedactor()))
		if err != nil {
			t.Errorf("walk %q: %v", doc, err)
			return
		}
		if strings.Contains(got, planted) {
			t.Errorf("walk %q: the needle survived: %s", doc, got)
		}
		if want, g := generic(t, doc, true), generic(t, got, false); !reflect.DeepEqual(want, g) {
			t.Errorf("walk %q:\n got %#v\nwant %#v", doc, g, want)
		}
	}
	for _, doc := range updecCorpus {
		check(doc)
	}
	seed := rand.Uint64() // #nosec G404 -- a logged seed makes failures reproducible
	t.Logf("seed %d", seed)
	rng := rand.New(rand.NewPCG(seed, 0)) // #nosec G404 -- seeded for reproducible cases
	for range 200 {
		check(randomDoc(rng, 0))
	}
}

func randomString(rng *rand.Rand) string {
	const alphabet = "abcXYZ019 _-:\"\\/\n\té✓<>&"
	rs := []rune(alphabet)
	n := rng.IntN(12)
	var b strings.Builder
	for range n {
		b.WriteRune(rs[rng.IntN(len(rs))])
	}
	s := b.String()
	if rng.IntN(4) == 0 {
		at := rng.IntN(len(s) + 1)
		s = s[:at] + planted + s[at:]
	}
	return s
}

// encodeString writes s as a JSON string, escaping random characters as \uXXXX.
func encodeString(rng *rand.Rand, s string) string {
	var b strings.Builder
	b.WriteByte('"')
	for _, r := range s {
		switch {
		case r == '"' || r == '\\' || r < 0x20 || rng.IntN(5) == 0:
			if r > 0xFFFF {
				hi, lo := 0xD800+((r-0x10000)>>10), 0xDC00+((r-0x10000)&0x3FF)
				fmt.Fprintf(&b, `\u%04X\u%04x`, hi, lo)
			} else {
				fmt.Fprintf(&b, `\u%04x`, r)
			}
		default:
			b.WriteRune(r)
		}
	}
	b.WriteByte('"')
	return b.String()
}

func randomDoc(rng *rand.Rand, depth int) string {
	k := rng.IntN(7)
	if depth > 3 {
		k = rng.IntN(4)
	}
	switch k {
	case 0:
		return "null"
	case 1:
		return []string{"true", "false"}[rng.IntN(2)]
	case 2:
		return []string{"0", "-0", "1e-7", "1767225600.123", "42", "-3.5E2"}[rng.IntN(6)]
	case 3:
		return encodeString(rng, randomString(rng))
	case 4, 5:
		n := rng.IntN(4)
		parts := make([]string, n)
		for i := range parts {
			parts[i] = randomDoc(rng, depth+1)
		}
		return "[" + strings.Join(parts, ",") + "]"
	default:
		n := rng.IntN(4)
		seen := map[string]bool{}
		var parts []string
		for range n {
			key := randomString(rng)
			if seen[strings.ReplaceAll(key, planted, "<redacted>")] {
				continue
			}
			seen[strings.ReplaceAll(key, planted, "<redacted>")] = true
			parts = append(parts, encodeString(rng, key)+":"+randomDoc(rng, depth+1))
		}
		return "{" + strings.Join(parts, ",") + "}"
	}
}

func wantProtocol(t *testing.T, what string, err error) {
	t.Helper()
	var pe *Error
	if !errors.As(err, &pe) || pe.Kind != KindProtocol {
		t.Errorf("%s: err %v, want KindProtocol", what, err)
	}
}

func TestUpdecRejects(t *testing.T) {
	for _, doc := range []string{"\"a\x01b\"", `"abc`, `[1,]`, `{"a"}`, `{"a":1,}`, `[1 2]`, `01`, `1.`, `-`, `tru`, `[1]]`, `{"a":1}x`, `{1:2}`} {
		_, err := reemit(newUpstreamDecoder(strings.NewReader(doc), plantedRedactor()))
		wantProtocol(t, doc, err)
	}
	// A lone surrogate becomes U+FFFD, as RFC 8259 decoders do; so does invalid UTF-8.
	for _, doc := range []string{`"\uD800"`, "\"a\xffb\""} {
		d := newUpstreamDecoder(strings.NewReader(doc), plantedRedactor())
		if k, err := d.Next(); err != nil || k != tokString || !strings.Contains(d.String(), "\uFFFD") {
			t.Errorf("%q: kind %v err %v string %q, want U+FFFD", doc, k, err, d.String())
		}
	}
}

func TestUpdecSample(t *testing.T) {
	sample := func(doc string) (float64, error) {
		d := newUpstreamDecoder(strings.NewReader(doc), plantedRedactor())
		if _, err := d.Next(); err != nil {
			return 0, err
		}
		return d.Sample()
	}
	if v, err := sample(`"1.5"`); err != nil || v != 1.5 {
		t.Errorf(`Sample("1.5") = %v %v`, v, err)
	}
	if v, err := sample(`"NaN"`); err != nil || !math.IsNaN(v) {
		t.Errorf(`Sample("NaN") = %v %v`, v, err)
	}
	if v, err := sample(`"-0"`); err != nil || math.Float64bits(v) != math.Float64bits(math.Copysign(0, -1)) {
		t.Errorf(`Sample("-0") = %v %v`, v, err)
	}
	_, err := sample(`"` + planted + `"`)
	wantProtocol(t, "Sample(secret)", err)
	if err != nil && strings.Contains(err.Error(), planted) {
		t.Errorf("the error text carries the token: %v", err)
	}
	_, err = sample(`1.5`)
	wantProtocol(t, "Sample(number token)", err)
}
