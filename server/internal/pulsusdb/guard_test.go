package pulsusdb

import (
	"testing"
	"time"
)

// unit:virtual-guard (pulsusdb half; T07-020, T07 §0).
func TestReservedIn(t *testing.T) {
	for _, c := range []struct{ text, name string }{
		{"ALERTS", "ALERTS"},
		{`ALERTS{alertstate="firing"}`, "ALERTS"},
		{"count(ALERTS_FOR_STATE)", "ALERTS_FOR_STATE"},
		{"rate(pulsus_anomaly_score[5m])", "pulsus_anomaly_score"},
		{`"ALERTS"`, "ALERTS"},
		{`{source="pulsus-dash"}`, `source="pulsus-dash"`},
		{"count(ALERTS)", "ALERTS"},
		{"ALERTS_FOR_STATE + ALERTS", "ALERTS_FOR_STATE"},
		{"up + ALERTS", "ALERTS"},
	} {
		name, ok := reservedIn(c.text)
		if !ok || name != c.name {
			t.Errorf("reservedIn(%q) = %q %v, want %q", c.text, name, ok, c.name)
		}
	}
	for _, text := range []string{"ALERTS_total", "my_ALERTS", "xALERTS", "pulsus_anomaly_scores",
		`{source="pulsus-dashboard"}`, "ALERTS:rate", "up", ""} {
		if name, ok := reservedIn(text); ok {
			t.Errorf("reservedIn(%q) = %q, want none", text, name)
		}
	}
}

// unit:virtual-guard (client half, the LogQL methods; T07-020 v1).
func TestLogGuard(t *testing.T) {
	u := newUpstream(t, logsAPI)
	c := New(Options{})
	rc := rcFor(testBinding(u.URL))
	ctx := ctxWithin(t, 10*time.Second)
	const reserved, near = `{source="pulsus-dash"}`, `{source="pulsus-dashboard"}`
	run := func(text string) map[string]error {
		q := a1Query(10, Backward)
		q.Query = text
		_, err1 := c.LogQueryRange(ctx, rc, q)
		_, _, err2 := c.LogVolume(ctx, rc, VolumeQuery{Query: text, Grid: a1Grid()})
		mq := LogMatchQuery{Query: text, StartNs: 1, EndNs: 2, Limit: 10}
		_, err3 := c.LogLabels(ctx, rc, mq)
		_, err4 := c.LogLabelValues(ctx, rc, "app", mq)
		_, err5 := c.LogSeries(ctx, rc, LogSeriesQuery{Match: []string{`{app="x"}`, text}, StartNs: 1, EndNs: 2, Limit: 10})
		return map[string]error{"LogQueryRange": err1, "LogVolume": err2, "LogLabels": err3, "LogLabelValues": err4, "LogSeries": err5}
	}
	before := len(u.requests())
	for name, err := range run(reserved) {
		field := "query"
		if name == "LogSeries" {
			field = "match/1"
		}
		if e, ok := err.(*Error); !ok || e.Kind != KindVirtual || e.Field != field {
			t.Errorf("%s(%s): %v, want KindVirtual at %s", name, reserved, err, field)
		}
	}
	if n := len(u.requests()) - before; n != 0 {
		t.Errorf("refused calls sent %d requests", n)
	}
	for name, err := range run(near) {
		if err != nil {
			t.Errorf("%s(%s): %v, want it passed", name, near, err)
		}
	}
}
