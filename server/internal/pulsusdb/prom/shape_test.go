package prom

import (
	"bytes"
	"encoding/json"
	"flag"
	"os"
	"reflect"
	"slices"
	"strings"
	"testing"

	"github.com/prometheus/prometheus/promql/parser"
)

var update = flag.Bool("update", false, "rewrite the functions section of wire/fixtures/plan/promql.json")

// expandedOf is the text whose shape a case records: the planned (or refused plan's) expanded
// text.
func expandedOf(c fxCase) (string, bool) {
	switch {
	case c.Planned != nil:
		return string(c.Planned.Expanded), true
	case c.Error != nil && c.Error.Planned != nil:
		return string(c.Error.Planned.Expanded), true
	}
	return "", false
}

func sameShape(a, b Shape) bool {
	if len(a.Metrics) == 0 && len(b.Metrics) == 0 {
		a.Metrics, b.Metrics = nil, nil
	}
	return reflect.DeepEqual(a, b)
}

// unit:plan-shape: ShapeOf of every case's expanded text equals its recorded shape.
func TestShapeOf(t *testing.T) {
	f := loadFixture(t)
	n := 0
	for _, c := range f.Plan {
		if c.Shape == nil {
			continue
		}
		text, ok := expandedOf(c)
		if !ok {
			t.Errorf("%s: a shape without a plan", c.Name)
			continue
		}
		n++
		if got, want := ShapeOf(text), c.Shape.shape(); !sameShape(got, want) {
			t.Errorf("%s: ShapeOf\n got %+v %v\nwant %+v %v", c.Name, got, got.Bare, want, want.Bare)
		}
	}
	if n == 0 {
		t.Fatal("no shapes")
	}
}

func typeName(v parser.ValueType) string { return string(v) }

// stableFunctions is the parser's non-experimental function table, sorted by name.
func stableFunctions() []fxFunction {
	var out []fxFunction
	for _, fn := range parser.Functions {
		if fn.Experimental {
			continue
		}
		args := make([]string, 0, len(fn.ArgTypes))
		for _, a := range fn.ArgTypes {
			args = append(args, typeName(a))
		}
		out = append(out, fxFunction{Name: fn.Name, ArgTypes: args, Variadic: fn.Variadic, Return: typeName(fn.ReturnType)})
	}
	slices.SortFunc(out, func(a, b fxFunction) int { return strings.Compare(a.Name, b.Name) })
	return out
}

// TestFunctionTable: the fixture's functions equal the parser's stable functions; -update
// rewrites the section (the last member of the file).
func TestFunctionTable(t *testing.T) {
	want := stableFunctions()
	if *update {
		b, err := os.ReadFile(fixturePath)
		if err != nil {
			t.Fatal(err)
		}
		i := bytes.LastIndex(b, []byte(`"functions":`))
		if i < 0 {
			t.Fatal("no functions member")
		}
		var buf bytes.Buffer
		buf.WriteString("\"functions\": [")
		for k, fn := range want {
			line, err := json.Marshal(fn)
			if err != nil {
				t.Fatal(err)
			}
			if k > 0 {
				buf.WriteByte(',')
			}
			buf.WriteString("\n  ")
			buf.Write(line)
		}
		buf.WriteString("\n ]\n}\n")
		out := append(append([]byte{}, b[:i]...), buf.Bytes()...)
		if err := os.WriteFile(fixturePath, out, 0o644); err != nil { // #nosec G306 -- a repository fixture
			t.Fatal(err)
		}
		return
	}
	got := loadFixture(t).Functions
	if !reflect.DeepEqual(got, want) {
		t.Errorf("functions: %d entries in the fixture, %d stable functions in the parser; run go test ./internal/pulsusdb/prom -run TestFunctionTable -update", len(got), len(want))
	}
}

// unit:plan-shape: ShapeOf never panics, keeps the bare span inside the text and gives the
// unknown shape on every parse error. go test -fuzz is not in CI; the seeds run.
func FuzzShapeOf(f *testing.F) {
	fx := fixture{}
	if b, err := os.ReadFile(fixturePath); err == nil {
		_ = json.Unmarshal(b, &fx)
	}
	for _, c := range fx.Plan {
		f.Add(string(c.Inputs.Query))
		if s, ok := expandedOf(c); ok {
			f.Add(s)
		}
	}
	for _, s := range []string{"", "\x00", strings.Repeat("(", 10_000), "{", "$"} {
		f.Add(s)
	}
	f.Fuzz(func(t *testing.T, text string) {
		s := ShapeOf(text)
		if s.Bare != nil && (s.Bare.From < 0 || s.Bare.To > len(text) || s.Bare.From > s.Bare.To) {
			t.Errorf("bare %+v outside [0, %d]", *s.Bare, len(text))
		}
		if _, err := promParser.ParseExpr(text); err != nil && !sameShape(s, Shape{ValueType: ValueUnknown}) {
			t.Errorf("parse error %v, but shape %+v", err, s)
		}
		if s.ValueType == "" {
			t.Errorf("no value type")
		}
	})
}
