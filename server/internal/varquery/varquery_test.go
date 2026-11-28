package varquery

import (
	"errors"
	"strings"
	"testing"
)

// unit:variable-query (plan #289 §3.3): the cases of boards/variableQuery.test.ts, with the same
// results (Go = TS).
func TestParse(t *testing.T) {
	long := strings.Repeat("l", 256)
	for _, c := range []struct {
		lang, text string
		want       *Query
	}{
		{"promql", "label_values(instance)", &Query{Label: "instance"}},
		{"promql", `label_values(up{job="a,b"}, instance)`, &Query{Label: "instance", Selector: `up{job="a,b"}`}},
		{"logql", `label_values({app="x"},pod)`, &Query{Label: "pod", Selector: `{app="x"}`}},
		{"promql", "values(x)", nil},
		{"promql", "label_values(up,)", nil},
		{"promql", "label_values(up, 9x)", nil},
		{"promql", " \tlabel_values ( up , instance ) \n", &Query{Label: "instance", Selector: "up"}},
		{"promql", `label_values(up{a='x,y'}, b)`, &Query{Label: "b", Selector: `up{a='x,y'}`}},
		{"promql", "label_values(up{a=`x,y`}, b)", &Query{Label: "b", Selector: "up{a=`x,y`}"}},
		{"promql", `label_values(up{a="x\",y"}, b)`, &Query{Label: "b", Selector: `up{a="x\",y"}`}},
		{"promql", `label_values(up{a="1",b="2"}, c)`, &Query{Label: "c", Selector: `up{a="1",b="2"}`}},
		{"promql", "label_values(" + long + ")", &Query{Label: long}},
		{"promql", "label_values(" + long + "l)", nil},
		{"promql", "label_values()", nil},
		{"promql", "label_values(, a)", nil},
		{"promql", "label_values(a", nil},
		{"promql", "label_values(a))", nil},
		{"promql", "label_values(a) x", nil},
		{"promql", "label_valuesx(a)", nil},
		{"promql", "label_values(a.b)", nil},
		{"promql", "", nil},
		{"traceql", "label_values(a)", nil},
	} {
		got, err := Parse(c.lang, c.text)
		switch {
		case c.want == nil && !errors.Is(err, ErrInvalid):
			t.Errorf("Parse(%q) = %+v, %v; want ErrInvalid", c.text, got, err)
		case c.want != nil && (err != nil || got != *c.want):
			t.Errorf("Parse(%q) = %+v, %v; want %+v", c.text, got, err, *c.want)
		}
	}
	if strings.Contains(ErrInvalid.Error(), "values(x)") {
		t.Error("the error carries text")
	}
}
