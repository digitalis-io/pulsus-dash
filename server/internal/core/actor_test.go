package core

import "testing"

func TestLocalActor(t *testing.T) {
	a := LocalActor()
	if got := a.ID.String(); got != "00000000-0000-0000-0000-000000000001" {
		t.Errorf("LocalActor().ID = %s, want 00000000-0000-0000-0000-000000000001", got)
	}
	if a.Kind != ActorLocal {
		t.Errorf("LocalActor().Kind = %q, want local", a.Kind)
	}
	if got := a.DisplayName(); got != "Local user" {
		t.Errorf("DisplayName() = %q, want Local user", got)
	}
	if got := (Actor{Kind: "user"}).DisplayName(); got != "Unknown" {
		t.Errorf("DisplayName() of a user = %q, want Unknown", got)
	}
}
