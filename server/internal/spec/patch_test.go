package spec

import (
	"bytes"
	"encoding/json"
	"strconv"
	"strings"
	"testing"
)

type op struct {
	Op    string          `json:"op"`
	Path  string          `json:"path"`
	Value json.RawMessage `json:"value"`
}

func decodeAny(t *testing.T, b []byte) any {
	t.Helper()
	d := json.NewDecoder(bytes.NewReader(b))
	d.UseNumber()
	var v any
	if err := d.Decode(&v); err != nil {
		t.Fatalf("decode %s: %v", b, err)
	}
	return v
}

func unescape(s string) string {
	return strings.ReplaceAll(strings.ReplaceAll(s, "~1", "/"), "~0", "~")
}

// applyPatch is a test-local RFC 6902 applier for add, remove and replace.
func applyPatch(t *testing.T, doc, patch []byte) []byte {
	t.Helper()
	var ops []op
	if err := json.Unmarshal(patch, &ops); err != nil {
		t.Fatalf("patch %s: %v", patch, err)
	}
	root := decodeAny(t, doc)
	for _, o := range ops {
		var val any
		if o.Op != "remove" {
			val = decodeAny(t, o.Value)
		}
		if o.Path == "" {
			root = val
			continue
		}
		parts := strings.Split(o.Path[1:], "/")
		var set func(cur any, i int) any
		set = func(cur any, i int) any {
			key := unescape(parts[i])
			last := i == len(parts)-1
			switch c := cur.(type) {
			case map[string]any:
				if last {
					if o.Op == "remove" {
						delete(c, key)
					} else {
						c[key] = val
					}
					return c
				}
				c[key] = set(c[key], i+1)
				return c
			case []any:
				n, err := strconv.Atoi(key)
				if err != nil {
					t.Fatalf("bad index %q", key)
				}
				if last {
					switch o.Op {
					case "remove":
						return append(c[:n:n], c[n+1:]...)
					case "add":
						c = append(c, nil)
						copy(c[n+1:], c[n:])
						c[n] = val
						return c
					default:
						c[n] = val
						return c
					}
				}
				c[n] = set(c[n], i+1)
				return c
			}
			t.Fatalf("path %s does not resolve", o.Path)
			return nil
		}
		root = set(root, 0)
	}
	return canon(t, root)
}

func TestDiffMinimalToFull(t *testing.T) {
	minimal, full := canon(t, fixture(t, "v1-minimal.json")), canon(t, fixture(t, "v1-full.json"))
	patch, err := Diff(minimal, full)
	if err != nil {
		t.Fatal(err)
	}
	var ops []op
	if err := json.Unmarshal(patch, &ops); err != nil {
		t.Fatal(err)
	}
	var got []string
	for _, o := range ops {
		got = append(got, o.Op+" "+o.Path)
	}
	want := "add /panels/0,add /panels/1,add /panels/2,add /sections/0,add /time,replace /title"
	if strings.Join(got, ",") != want {
		t.Errorf("ops = %v, want %s", got, want)
	}
	if applied := applyPatch(t, minimal, patch); !bytes.Equal(applied, full) {
		t.Errorf("applyPatch(minimal, patch) = %s, want %s", applied, full)
	}
}

func TestDiffCases(t *testing.T) {
	cases := []struct{ a, b, want string }{
		{`{"a":1}`, `{"a":1}`, `[]`},
		{`{"a":[1,2,3]}`, `{"a":[1]}`, `[{"op":"remove","path":"/a/2"},{"op":"remove","path":"/a/1"}]`},
		{`{"a":[1]}`, `{"a":[1,2,3]}`, `[{"op":"add","path":"/a/1","value":2},{"op":"add","path":"/a/2","value":3}]`},
		{`{}`, `{"x/y~":true}`, `[{"op":"add","path":"/x~1y~0","value":true}]`},
		{`{"k":1,"z":"q"}`, `{"z":"r"}`, `[{"op":"remove","path":"/k"},{"op":"replace","path":"/z","value":"r"}]`},
		{`{"a":{"b":[1,{"c":2}]}}`, `{"a":{"b":[2,{"c":3,"d":null}]}}`, `[{"op":"replace","path":"/a/b/0","value":2},{"op":"replace","path":"/a/b/1/c","value":3},{"op":"add","path":"/a/b/1/d","value":null}]`},
		{`[1]`, `{"a":1}`, `[{"op":"replace","path":"","value":{"a":1}}]`},
	}
	for _, tc := range cases {
		got, err := Diff([]byte(tc.a), []byte(tc.b))
		if err != nil {
			t.Fatal(err)
		}
		if string(got) != tc.want {
			t.Errorf("Diff(%s, %s) = %s, want %s", tc.a, tc.b, got, tc.want)
		}
		if applied, want := applyPatch(t, []byte(tc.a), got), canon(t, []byte(tc.b)); !bytes.Equal(applied, want) {
			t.Errorf("applyPatch(%s, Diff) = %s, want %s", tc.a, applied, want)
		}
	}
	got, err := Diff(nil, []byte(`{"title":"b"}`))
	if err != nil {
		t.Fatal(err)
	}
	if want := `[{"op":"add","path":"","value":{"title":"b"}}]`; string(got) != want {
		t.Errorf("Diff(nil, b) = %s, want %s", got, want)
	}
}
