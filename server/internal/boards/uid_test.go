package boards

import (
	"regexp"
	"testing"
)

func TestNewUID(t *testing.T) {
	pattern := regexp.MustCompile(`^[0-9a-z]{14}$`)
	seen := make(map[string]bool, 10000)
	for range 10000 {
		uid, err := NewUID()
		if err != nil {
			t.Fatal(err)
		}
		if !pattern.MatchString(uid) {
			t.Fatalf("NewUID() = %q, want ^[0-9a-z]{14}$", uid)
		}
		if seen[uid] {
			t.Fatalf("NewUID() repeated %q", uid)
		}
		seen[uid] = true
	}
}
