package telemetry

import (
	"bytes"
	"strings"
	"testing"
)

func TestNewLogger(t *testing.T) {
	if _, err := NewLogger("loud", "json", &bytes.Buffer{}); err == nil || !strings.Contains(err.Error(), "loud") {
		t.Fatalf("NewLogger(loud) error = %v, want one naming the value", err)
	}
	var buf bytes.Buffer
	l, err := NewLogger("info", "json", &buf)
	if err != nil || l == nil {
		t.Fatalf("NewLogger(info, json) = %v, %v", l, err)
	}
	l.Info("hello")
	if !strings.Contains(buf.String(), `"level":"INFO"`) {
		t.Fatalf("record %q does not encode \"level\":\"INFO\"", buf.String())
	}
}
