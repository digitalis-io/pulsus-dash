package pulsusdb

import (
	"net/http"
	"slices"
	"strings"
	"testing"
	"time"
)

// Label names that are not legacy names are sent in the U__ form, never percent-escaped.
func TestEscapeLabelName(t *testing.T) {
	for _, c := range [][2]string{
		{"job", "job"},
		{"__name__", "__name__"},
		{"a1", "a1"},
		{"1a", "U___31_a"},
		{"http.status", "U__http_2e_status"},
		{"μs", "U___3bc_s"},
		{"my_label.x", "U__my__label_2e_x"},
		{"a/b", "U__a_2f_b"},
		{"a b%", "U__a_20_b_25_"},
		{"a:b", "U__a_3a_b"},
		{"\xff", "U___FFFD_"},
	} {
		got := escapeLabelName(c[0])
		if got != c[1] || strings.Contains(got, "%") {
			t.Errorf("escapeLabelName(%q) = %q, want %q", c[0], got, c[1])
		}
	}
}

// Completion times are whole seconds: labels and label values snapped to the minute (start
// floored, end raised, one minute apart at least), series to the second (start floored, end raised).
func TestCompletionTimes(t *testing.T) {
	u := newUpstream(t, func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, "/series") {
			answer(200, `{"status":"success","data":[]}`)(w, r)
			return
		}
		answer(200, okLabels)(w, r)
	})
	c := New(Options{})
	rc := rcFor(testBinding(u.URL))
	ctx := ctxWithin(t, 10*time.Second)
	q := func(from, to int64) MatchQuery {
		return MatchQuery{Match: []string{"up"}, Start: time.UnixMilli(from), End: time.UnixMilli(to), Limit: 10}
	}
	type want struct{ path, start, end string }
	var wants []want
	run := func(qq MatchQuery, minute, series want) {
		if _, err := c.Labels(ctx, rc, qq); err != nil {
			t.Fatal(err)
		}
		if _, err := c.LabelValues(ctx, rc, "http.status", qq); err != nil {
			t.Fatal(err)
		}
		if _, err := c.Series(ctx, rc, qq); err != nil {
			t.Fatal(err)
		}
		wants = append(wants, want{"/api/v1/labels", minute.start, minute.end},
			want{"/api/v1/label/U__http_2e_status/values", minute.start, minute.end}, want{"/api/v1/series", series.start, series.end})
	}
	run(q(1767225601500, 1767229170200), want{"", "1767225600", "1767229200"}, want{"", "1767225601", "1767229171"})
	run(q(1767225605000, 1767225610000), want{"", "1767225600", "1767225660"}, want{"", "1767225605", "1767225610"})
	run(q(1767225600000, 1767225600000), want{"", "1767225600", "1767225660"}, want{"", "1767225600", "1767225600"})
	reqs := u.requests()
	if len(reqs) != len(wants) {
		t.Fatalf("%d requests, want %d", len(reqs), len(wants))
	}
	for i, w := range wants {
		f := reqs[i].Form
		if reqs[i].Path != w.path || f.Get("start") != w.start || f.Get("end") != w.end || strings.Contains(reqs[i].Path, "%") {
			t.Errorf("request %d: %s start=%s end=%s, want %s start=%s end=%s", i, reqs[i].Path, f.Get("start"), f.Get("end"), w.path, w.start, w.end)
		}
	}
}

// labels is POST form first; a 405 or a 400 retries it once as GET.
func TestLabelsMethodFallback(t *testing.T) {
	for _, c := range []struct {
		status  int
		methods []string
		kind    ErrorKind
	}{
		{200, []string{"POST"}, 0},
		{405, []string{"POST", "GET"}, 0},
		{400, []string{"POST", "GET"}, 0},
		{404, []string{"POST"}, KindProtocol},
		{422, []string{"POST"}, KindTooBroad},
	} {
		u := newUpstream(t, func(w http.ResponseWriter, r *http.Request) {
			if r.Method == http.MethodPost && c.status != 200 {
				answer(c.status, `{"status":"error","errorType":"bad_data","error":"x"}`)(w, r)
				return
			}
			answer(200, okLabels)(w, r)
		})
		v, err := New(Options{}).Labels(ctxWithin(t, 10*time.Second), rcFor(testBinding(u.URL)), labelsQuery())
		var methods []string
		for _, r := range u.requests() {
			methods = append(methods, r.Method)
		}
		if !slices.Equal(methods, c.methods) {
			t.Errorf("POST answered %d: methods %v, want %v", c.status, methods, c.methods)
		}
		if c.kind == 0 && (err != nil || !slices.Equal(v.Values, []string{"a"})) {
			t.Errorf("POST answered %d: %+v %v, want [a]", c.status, v, err)
		}
		if c.kind != 0 && kindOf(err) != c.kind {
			t.Errorf("POST answered %d: err %v, want %v", c.status, err, c.kind)
		}
	}
}
