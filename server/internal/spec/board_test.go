package spec

import (
	"bytes"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

func fixture(t *testing.T, name string) []byte {
	t.Helper()
	b, err := os.ReadFile(filepath.Join("..", "..", "..", "api", "fixtures", "board-spec", name)) //nolint:gosec // fixture names are constants of the tests
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func canon(t *testing.T, v any) []byte {
	t.Helper()
	b, err := Canonical(v)
	if err != nil {
		t.Fatalf("Canonical: %v", err)
	}
	return b
}

func TestV1FixturesRoundTrip(t *testing.T) {
	for _, name := range []string{"v1-minimal.json", "v1-full.json"} {
		t.Run(name, func(t *testing.T) {
			raw := fixture(t, name)
			b, err := ParseBoard(raw)
			if err != nil {
				t.Fatalf("ParseBoard: %v", err)
			}
			if got, want := canon(t, b), canon(t, raw); !bytes.Equal(got, want) {
				t.Errorf("Canonical(board) = %s\nwant Canonical(raw) = %s", got, want)
			}
			again, err := ParseBoard(canon(t, b))
			if err != nil {
				t.Fatalf("ParseBoard(canonical): %v", err)
			}
			if !reflect.DeepEqual(again, b) {
				t.Errorf("ParseBoard(Canonical(board)) = %+v, want %+v", again, b)
			}
		})
	}
}

func TestUpcasterAcceptsV1Unchanged(t *testing.T) {
	for _, name := range []string{"v1-minimal.json", "v1-full.json"} {
		t.Run(name, func(t *testing.T) {
			raw := fixture(t, name)
			b, err := DecodeBoard(raw, 1)
			if err != nil {
				t.Fatalf("DecodeBoard(raw, 1): %v", err)
			}
			if got, want := canon(t, b), canon(t, raw); !bytes.Equal(got, want) {
				t.Errorf("DecodeBoard(raw, 1) = %s, want %s", got, want)
			}
			// Version 2 adds members only: a v1 spec is the identity upcast (T11-016).
			b2, err := DecodeBoard(raw, 2)
			if err != nil {
				t.Fatalf("DecodeBoard(raw, 2): %v", err)
			}
			if got, want := canon(t, b2), canon(t, raw); !bytes.Equal(got, want) {
				t.Errorf("DecodeBoard(raw, 2) = %s, want %s", got, want)
			}
			// Version 3 adds members only (#173): the identity upcast again.
			b3, err := DecodeBoard(raw, 3)
			if err != nil {
				t.Fatalf("DecodeBoard(raw, 3): %v", err)
			}
			if got, want := canon(t, b3), canon(t, raw); !bytes.Equal(got, want) {
				t.Errorf("DecodeBoard(raw, 3) = %s, want %s", got, want)
			}
			// Version 4 adds tags (#215): the identity upcast again.
			b4, err := DecodeBoard(raw, 4)
			if err != nil {
				t.Fatalf("DecodeBoard(raw, 4): %v", err)
			}
			if got, want := canon(t, b4), canon(t, raw); !bytes.Equal(got, want) {
				t.Errorf("DecodeBoard(raw, 4) = %s, want %s", got, want)
			}
			// Version 5 adds widgets (#198 Part 1): query optional, text and clock; the identity again.
			b5, err := DecodeBoard(raw, 5)
			if err != nil {
				t.Fatalf("DecodeBoard(raw, 5): %v", err)
			}
			if got, want := canon(t, b5), canon(t, raw); !bytes.Equal(got, want) {
				t.Errorf("DecodeBoard(raw, 5) = %s, want %s", got, want)
			}
			if _, err := DecodeBoard(raw, 6); !errors.Is(err, ErrSchemaTooNew) {
				t.Errorf("DecodeBoard(raw, 6) = %v, want ErrSchemaTooNew", err)
			}
			if _, err := DecodeBoard(raw, 0); !errors.Is(err, ErrSchemaVersion) {
				t.Errorf("DecodeBoard(raw, 0) = %v, want ErrSchemaVersion", err)
			}
		})
	}
}

func TestMinimalContentHash(t *testing.T) {
	c := canon(t, fixture(t, "v1-minimal.json"))
	if want := `{"panels":[],"sections":[],"title":"New board"}`; string(c) != want {
		t.Errorf("Canonical = %s, want %s", c, want)
	}
	h := ContentHash(c)
	if got, want := hex.EncodeToString(h[:]), "f40543b019d375e2e7aa7965bfb4a7fe190d742bcc402550e821a5523725bb37"; got != want {
		t.Errorf("ContentHash = %s, want %s", got, want)
	}
}

func TestV2FixtureRoundTrip(t *testing.T) {
	for _, name := range []string{"v2-full.json", "v2-threshold-bounds.json"} {
		t.Run(name, func(t *testing.T) {
			raw := fixture(t, name)
			b, err := ParseBoard(raw)
			if err != nil {
				t.Fatalf("ParseBoard: %v", err)
			}
			if got, want := canon(t, b), canon(t, raw); !bytes.Equal(got, want) {
				t.Errorf("Canonical(board) = %s\nwant Canonical(raw) = %s", got, want)
			}
		})
	}
}

func TestDecodeBoardUpTo(t *testing.T) {
	raw := fixture(t, "v2-full.json")
	if _, err := DecodeBoardUpTo(raw, 2, 1); !errors.Is(err, ErrSchemaTooNew) {
		t.Errorf("DecodeBoardUpTo(raw, 2, 1) = %v, want ErrSchemaTooNew", err)
	}
	b, err := DecodeBoardUpTo(raw, 2, 2)
	if err != nil {
		t.Fatalf("DecodeBoardUpTo(raw, 2, 2): %v", err)
	}
	if got, want := canon(t, b), canon(t, raw); !bytes.Equal(got, want) {
		t.Errorf("DecodeBoardUpTo(raw, 2, 2) = %s, want %s", got, want)
	}
	if BoardSchemaVersion != 5 {
		t.Errorf("BoardSchemaVersion = %d, want 5", BoardSchemaVersion)
	}
}

// v3CanonicalSHA256 is the SHA-256 of v3-full.json's canonical form; boards/spec.test.ts holds the
// same value, so the two canonical forms are byte-equal.
const v3CanonicalSHA256 = "293e4cd4027bf9803c3ce2e467f36d8c41fb0f5b102804b496700df48c22d193"

// unit:board-spec v3 (#173 Part 1): v3-full holds every option key of each kind, categoryBy ”
// and absent and "version", min 0 with max 500, line with {} and a section.
func TestV3FixtureRoundTrip(t *testing.T) {
	raw := fixture(t, "v3-full.json")
	b, err := ParseBoard(raw)
	if err != nil {
		t.Fatalf("ParseBoard: %v", err)
	}
	c := canon(t, b)
	if want := canon(t, raw); !bytes.Equal(c, want) {
		t.Errorf("Canonical(board) = %s\nwant Canonical(raw) = %s", c, want)
	}
	h := ContentHash(c)
	if got := hex.EncodeToString(h[:]); got != v3CanonicalSHA256 {
		t.Errorf("ContentHash = %s, want %s", got, v3CanonicalSHA256)
	}
	again, err := ParseBoard(c)
	if err != nil {
		t.Fatalf("ParseBoard(canonical): %v", err)
	}
	if !reflect.DeepEqual(again, b) {
		t.Errorf("ParseBoard(Canonical(board)) = %+v, want %+v", again, b)
	}
	if _, err := DecodeBoardUpTo(raw, 3, 2); !errors.Is(err, ErrSchemaTooNew) {
		t.Errorf("DecodeBoardUpTo(raw, 3, 2) = %v, want ErrSchemaTooNew", err)
	}
	b3, err := DecodeBoardUpTo(raw, 3, 3)
	if err != nil {
		t.Fatalf("DecodeBoardUpTo(raw, 3, 3): %v", err)
	}
	if got := canon(t, b3); !bytes.Equal(got, c) {
		t.Errorf("DecodeBoardUpTo(raw, 3, 3) = %s, want %s", got, c)
	}
	for _, name := range []string{"v2-full.json", "v2-threshold-bounds.json"} {
		v2 := fixture(t, name)
		up, err := DecodeBoard(v2, 2)
		if err != nil {
			t.Fatalf("DecodeBoard(%s, 2): %v", name, err)
		}
		if got, want := canon(t, up), canon(t, v2); !bytes.Equal(got, want) {
			t.Errorf("DecodeBoard(%s, 2) = %s, want %s", name, got, want)
		}
	}
}

// v4CanonicalSHA256 is the SHA-256 of v4-board-tags.json's canonical form; boards/spec.test.ts
// holds the same value, so the two canonical forms are byte-equal.
const v4CanonicalSHA256 = "1ee8fecd5dbd9f6d70f5b8552f8a5aeb312f9499c5e969ff7d2a231d753e3a3f"

// unit:board-spec v4 (#215, T24-029): tags are kept in order, an empty list canonicalises to no
// key, and the previous release (schema 3) refuses a v4 row.
func TestV4FixtureRoundTrip(t *testing.T) {
	raw := fixture(t, "v4-board-tags.json")
	b, err := ParseBoard(raw)
	if err != nil {
		t.Fatalf("ParseBoard: %v", err)
	}
	c := canon(t, b)
	if want := canon(t, raw); !bytes.Equal(c, want) {
		t.Errorf("Canonical(board) = %s\nwant Canonical(raw) = %s", c, want)
	}
	if !bytes.Contains(c, []byte(`"tags":["team:payments","prod"]`)) {
		t.Errorf("Canonical = %s, want the tags in their order", c)
	}
	h := ContentHash(c)
	if got := hex.EncodeToString(h[:]); got != v4CanonicalSHA256 {
		t.Errorf("ContentHash = %s, want %s", got, v4CanonicalSHA256)
	}
	empty, err := ParseBoard([]byte(`{"title":"T","panels":[],"sections":[],"tags":[]}`))
	if err != nil {
		t.Fatalf("ParseBoard(tags []): %v", err)
	}
	if got, want := string(canon(t, empty)), `{"panels":[],"sections":[],"title":"T"}`; got != want {
		t.Errorf("Canonical(tags []) = %s, want %s", got, want)
	}
	v3 := fixture(t, "v3-full.json")
	up, err := DecodeBoardUpTo(v3, 3, 4)
	if err != nil {
		t.Fatalf("DecodeBoardUpTo(v3-full, 3, 4): %v", err)
	}
	if got, want := canon(t, up), canon(t, v3); !bytes.Equal(got, want) {
		t.Errorf("DecodeBoardUpTo(v3-full, 3, 4) = %s, want %s", got, want)
	}
	if _, err := DecodeBoardUpTo(raw, 4, 3); !errors.Is(err, ErrSchemaTooNew) {
		t.Errorf("DecodeBoardUpTo(v4, 4, 3) = %v, want ErrSchemaTooNew", err)
	}
}

// The option tables (shape.go) equal api/fixtures/board-spec/option-keys.json, which the client's
// suite compares with boards/options.ts: each key's type, the members of the object keys (zones'
// items, countdown) and the keys of each kind.
func TestOptionKeys(t *testing.T) {
	var want struct {
		Types   map[string]string   `json:"types"`
		Members map[string][]string `json:"members"`
		Kinds   map[string][]string `json:"kinds"`
	}
	if err := json.Unmarshal(fixture(t, "option-keys.json"), &want); err != nil {
		t.Fatal(err)
	}
	names := map[kind]string{kString: "string", kBool: "bool", kNumber: "number", kArray: "array", kObject: "object"}
	types := map[string]string{}
	members := map[string][]string{}
	for _, f := range optionFields {
		types[f.name] = names[f.t.kind]
		shape := f.t.shape
		if f.t.kind == kArray && f.t.elem != nil {
			shape = f.t.elem.shape
		}
		if len(shape) == 0 {
			continue
		}
		for _, m := range shape {
			if !m.required || m.t.kind != kString {
				t.Errorf("%s.%s: required %v kind %v, want a required string", f.name, m.name, m.required, m.t.kind)
			}
			members[f.name] = append(members[f.name], m.name)
		}
	}
	if !reflect.DeepEqual(types, want.Types) {
		t.Errorf("option types = %v, want %v", types, want.Types)
	}
	if !reflect.DeepEqual(members, want.Members) {
		t.Errorf("option members = %v, want %v", members, want.Members)
	}
	kinds := map[string][]string{}
	for _, k := range visKinds {
		names := []string{}
		for _, f := range optionShape(k) {
			names = append(names, f.name)
		}
		kinds[k] = names
	}
	if !reflect.DeepEqual(kinds, want.Kinds) {
		t.Errorf("option kinds = %v, want %v", kinds, want.Kinds)
	}
}

// v5CanonicalSHA256 is the SHA-256 of v5-widgets.json's canonical form; boards/spec.test.ts holds
// the same value, so the two canonical forms are byte-equal.
const v5CanonicalSHA256 = "a42813fc4b36e478ec6dac2a4b5707bd1c50377def15a749ea2d34a8b6bd134f"

// unit:board-spec-widgets (#198 Part 1, T24-003, T11-016): the widgets version. Only p-5 has a
// query; the fixture is valid, canonical and readable by this version only; v4 upcasts unchanged.
func TestV5WidgetsFixture(t *testing.T) {
	if BoardSchemaVersion != 5 {
		t.Errorf("BoardSchemaVersion = %d, want 5", BoardSchemaVersion)
	}
	raw := fixture(t, "v5-widgets.json")
	b, err := ParseNewBoard(raw)
	if err != nil {
		t.Fatalf("ParseNewBoard: %v", err)
	}
	c := canon(t, b)
	if want := canon(t, raw); !bytes.Equal(c, want) {
		t.Errorf("Canonical(board) = %s\nwant Canonical(raw) = %s", c, want)
	}
	h := ContentHash(c)
	if got := hex.EncodeToString(h[:]); got != v5CanonicalSHA256 {
		t.Errorf("ContentHash = %s, want %s", got, v5CanonicalSHA256)
	}
	var withQuery []string
	for _, p := range b.Panels {
		if p.Query != nil {
			withQuery = append(withQuery, p.ID)
		}
	}
	for _, s := range b.Sections {
		for _, p := range s.Panels {
			if p.Query != nil {
				withQuery = append(withQuery, p.ID)
			}
		}
	}
	if !reflect.DeepEqual(withQuery, []string{"p-5"}) {
		t.Errorf("panels with a query = %v, want [p-5]", withQuery)
	}
	if n := bytes.Count(c, []byte(`"query"`)); n != 1 {
		t.Errorf("canonical form holds %d query keys, want 1 (p-5)", n)
	}
	again, err := ParseBoard(c)
	if err != nil {
		t.Fatalf("ParseBoard(canonical): %v", err)
	}
	if !reflect.DeepEqual(again, b) {
		t.Errorf("ParseBoard(Canonical(board)) = %+v, want %+v", again, b)
	}
	v4 := fixture(t, "v4-board-tags.json")
	up, err := DecodeBoardUpTo(v4, 4, 5)
	if err != nil {
		t.Fatalf("DecodeBoardUpTo(v4-board-tags, 4, 5): %v", err)
	}
	if got, want := canon(t, up), canon(t, v4); !bytes.Equal(got, want) {
		t.Errorf("DecodeBoardUpTo(v4-board-tags, 4, 5) = %s, want %s", got, want)
	}
	if _, err := DecodeBoardUpTo(raw, 5, 4); !errors.Is(err, ErrSchemaTooNew) {
		t.Errorf("DecodeBoardUpTo(v5, 5, 4) = %v, want ErrSchemaTooNew", err)
	}
	if z := b.Zones(); !reflect.DeepEqual(z, map[string]bool{"": true, "Asia/Tokyo": true, "America/New_York": true}) {
		t.Errorf("Zones() = %v", z)
	}
}
