package spec

import "testing"

func TestCanonicalStable(t *testing.T) {
	for _, in := range []string{`{"b":1,"a":"<&>"}`, `{"a":"<&>","b":1}`, " {\"a\" : \"<&>\",\n \"b\":1} "} {
		got, err := Canonical([]byte(in))
		if err != nil {
			t.Fatal(err)
		}
		if want := `{"a":"<&>","b":1}`; string(got) != want {
			t.Errorf("Canonical(%s) = %s, want %s", in, got, want)
		}
	}
	got, err := Canonical(map[string]any{"z": []int{1, 2}, "a": nil})
	if err != nil {
		t.Fatal(err)
	}
	if want := `{"a":null,"z":[1,2]}`; string(got) != want {
		t.Errorf("Canonical(map) = %s, want %s", got, want)
	}
}
