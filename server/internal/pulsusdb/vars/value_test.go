package vars

import (
	"encoding/json"
	"strings"
	"testing"
)

func ptr(s string) *string { return &s }

func multi(vs ...string) Value { return Value{Values: vs} }

// unit:var-render (T07-031, plan #289 §3.4): every Render cell.
func TestRenderTable(t *testing.T) {
	legacy := Value{Text: "a.b|c", Legacy: true}
	one := multi("a.b")
	two := multi("a", "b.c")
	all := Value{All: ptr(".+")}
	re, eq, top := Ctx{Kind: CtxRe}, Ctx{Kind: CtxEq}, Ctx{Kind: CtxTop}
	none := Ctx{Kind: CtxNone, Where: WhereTopLevel}
	for _, c := range []struct {
		name string
		v    Value
		c    Ctx
		want string
		ok   bool
	}{
		{"legacy re", legacy, re, "a.b|c", true},
		{"legacy eq", legacy, eq, "a.b|c", true},
		{"legacy top", legacy, top, "a.b|c", true},
		{"legacy none", legacy, none, "a.b|c", true},
		{"one re", one, re, `(?-i:(?:a\.b))`, true},
		{"one eq", one, eq, "a.b", true},
		{"one top, not a token", one, top, "", false},
		{"one top, a duration", multi("5m"), top, "5m", true},
		{"one none", one, none, "", false},
		{"two re", two, re, `(?-i:(?:a|b\.c))`, true},
		{"two re in order", multi("b", "a"), re, `(?-i:(?:b|a))`, true},
		{"two eq", two, eq, "", false},
		{"two top", multi("1", "2"), top, "", false},
		{"two none", two, none, "", false},
		{"all re", all, re, ".+", true},
		{"all eq", all, eq, "", false},
		{"all top", Value{All: ptr("5")}, top, "", false},
		{"all none", all, none, "", false},
		{"metacharacters quoted", multi(`a\b`, `(x)`, `^$`, `[]{}*+?|`), re, `(?-i:(?:a\\b|\(x\)|\^\$|\[\]\{\}\*\+\?\|))`, true},
	} {
		got, ok := Render(c.v, c.c)
		if got != c.want || ok != c.ok {
			t.Errorf("%s: Render = %q, %v; want %q, %v", c.name, got, ok, c.want, c.ok)
		}
	}
}

// unit:var-render: a structured value is refused in every CtxNone place, a legacy string written.
func TestRenderRefusedInEveryNonePlace(t *testing.T) {
	wheres := append([]string{WhereTopLevel, WhereFunctionArgument, WhereComment, WhereOrFilter, WherePatternFilter}, StageKeywords...)
	if len(wheres) != 17 {
		t.Fatalf("%d places, want the 17 of plan #289 §3.4", len(wheres))
	}
	for _, w := range wheres {
		c := Ctx{Kind: CtxNone, Where: w}
		for _, v := range []Value{multi("a"), multi("a", "b"), {All: ptr(".*")}} {
			if got, ok := Render(v, c); ok || got != "" {
				t.Errorf("%s: Render(%+v) = %q, %v; want refused", w, v, got, ok)
			}
		}
		if got, ok := Render(Value{Text: "x y", Legacy: true}, c); !ok || got != "x y" {
			t.Errorf("%s: legacy Render = %q, %v", w, got, ok)
		}
	}
}

// unit:var-render: TopToken accepts unsigned numbers and durations only.
func TestTopToken(t *testing.T) {
	for _, s := range []string{"5m", "1.5e3", "0x1F", ".5", "1h30m", "0", "10", "1.", "2E-3", "15s", "1y", "100ms"} {
		if !TopToken(s) {
			t.Errorf("TopToken(%q) = false, want true", s)
		}
	}
	for _, s := range []string{"atan2", "and", "bool", "job_name", "a:b", "Inf", "NaN", "-1", "x}", "a b", "1+1",
		"", "+1", "1m and", "or", "1e", "0x", "5m)", "1_000", "inf", "nan", "5 m", ".", "1h30"} {
		if TopToken(s) {
			t.Errorf("TopToken(%q) = true, want false", s)
		}
	}
}

// unit:var-render: SelectionBytes is the UTF-8 length of the JSON array, JSON.stringify's escapes.
func TestSelectionBytes(t *testing.T) {
	for _, c := range []struct {
		vs   []string
		want int
	}{
		{[]string{"é"}, 6},
		{[]string{"a", "b"}, 9},
		{[]string{`"`}, 6},
		{[]string{`\`}, 6},
		{[]string{"\n"}, 6},
		{[]string{"\x01"}, 10},
		{[]string{" "}, 7},
		{[]string{"<&>"}, 7},
		{[]string{"\U0001F600"}, 8},
		{nil, 2},
	} {
		if got := SelectionBytes(c.vs); got != c.want {
			t.Errorf("SelectionBytes(%q) = %d, want %d", c.vs, got, c.want)
		}
	}
}

// unit:var-render: the bounds of each form.
func TestCheck(t *testing.T) {
	big := strings.Repeat("a", 4096)
	many := make([]string, 201)
	for i := range many {
		many[i] = "v" + strings.Repeat("x", i%7) + string(rune('a'+i%26))
	}
	// 200 values of 4-byte runes: 200 × (2 + 4k) + 199 + 2 bytes.
	runes := func(total int) []string {
		vs := make([]string, 200)
		n := 2 + 199 + 200*2 // brackets, commas, quotes
		for i := range vs {
			vs[i] = strings.Repeat("\U0001F600", 80)
			n += 320
		}
		// Grow the last value with ASCII until the total is reached.
		vs[199] += strings.Repeat("b", total-n)
		return vs
	}
	for _, c := range []struct {
		name string
		v    Value
		ok   bool
	}{
		{"legacy", Value{Text: big, Legacy: true}, true},
		{"legacy too long", Value{Text: big + "a", Legacy: true}, false},
		{"legacy not UTF-8", Value{Text: "\xff", Legacy: true}, false},
		{"one", multi("a"), true},
		{"empty list", Value{Values: []string{}}, false},
		{"200 values", Value{Values: many[:200]}, true},
		{"201 values", Value{Values: many}, false},
		{"a value at 4096", multi(big), true},
		{"a value over 4096", multi(big + "a"), false},
		{"a value not UTF-8", multi("\xff"), false},
		{"65536 bytes", Value{Values: runes(65536)}, true},
		{"65537 bytes", Value{Values: runes(65537)}, false},
		{"all", Value{All: ptr(".+")}, true},
		{"all empty", Value{All: ptr("")}, false},
		{"all over 4096", Value{All: ptr(big + "a")}, false},
	} {
		key, ok := Check(c.v)
		if ok != c.ok || (!ok && key != "field.range") || (ok && key != "") {
			t.Errorf("%s: Check = %q, %v; want ok %v", c.name, key, ok, c.ok)
		}
	}
	if n := SelectionBytes(runes(65537)); n != 65537 {
		t.Errorf("the 65 537-byte selection is %d bytes", n)
	}
}

// unit:vars-decode (Go side): the three shapes, and every other shape is a type error.
func TestValueUnmarshal(t *testing.T) {
	for _, c := range []struct {
		in   string
		want Value
	}{
		{`"a"`, Value{Text: "a", Legacy: true}},
		{`""`, Value{Text: "", Legacy: true}},
		{`{"values":["a","b"]}`, Value{Values: []string{"a", "b"}}},
		{`{"values":[]}`, Value{Values: []string{}}},
		{`{"all":".+"}`, Value{All: ptr(".+")}},
	} {
		var v Value
		if err := json.Unmarshal([]byte(c.in), &v); err != nil {
			t.Errorf("%s: %v", c.in, err)
			continue
		}
		if v.Text != c.want.Text || v.Legacy != c.want.Legacy || (v.Values == nil) != (c.want.Values == nil) ||
			strings.Join(v.Values, ",") != strings.Join(c.want.Values, ",") || (v.All == nil) != (c.want.All == nil) ||
			(v.All != nil && *v.All != *c.want.All) {
			t.Errorf("%s: %+v, want %+v", c.in, v, c.want)
		}
	}
	for _, in := range []string{`{"x":1}`, `{"values":["a"],"all":".*"}`, `{"values":"a"}`, `{"values":[1]}`,
		`{"all":1}`, `{}`, `1`, `true`, `null`, `["a"]`, `{"values":null}`, `{"all":null}`} {
		var m Map
		err := json.Unmarshal([]byte(`{"a":"x","n":`+in+`}`), &m)
		var te *TypeError
		if err == nil || !errorsAs(err, &te) || te.Name != "n" {
			t.Errorf("%s: error %v, want a TypeError at n", in, err)
		}
	}
}
