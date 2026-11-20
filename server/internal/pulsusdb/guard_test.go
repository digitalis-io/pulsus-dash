package pulsusdb

import "testing"

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
