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
			if _, err := DecodeBoard(raw, 4); !errors.Is(err, ErrSchemaTooNew) {
				t.Errorf("DecodeBoard(raw, 4) = %v, want ErrSchemaTooNew", err)
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
	if BoardSchemaVersion != 3 {
		t.Errorf("BoardSchemaVersion = %d, want 3", BoardSchemaVersion)
	}
}

// v3CanonicalSHA256 is the SHA-256 of v3-full.json's canonical form; boards/spec.test.ts holds the
// same value, so the two canonical forms are byte-equal.
const v3CanonicalSHA256 = "293e4cd4027bf9803c3ce2e467f36d8c41fb0f5b102804b496700df48c22d193"

// unit:board-spec v3 (#173 Part 1): v3-full holds every option key of each kind, categoryBy ''
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

// The option tables (shape.go) equal api/fixtures/board-spec/option-keys.json, which the client's
// suite compares with boards/options.ts.
func TestOptionKeys(t *testing.T) {
	var want struct {
		Types map[string]string   `json:"types"`
		Kinds map[string][]string `json:"kinds"`
	}
	if err := json.Unmarshal(fixture(t, "option-keys.json"), &want); err != nil {
		t.Fatal(err)
	}
	types := map[string]string{}
	for _, f := range optionFields {
		types[f.name] = map[kind]string{kString: "string", kBool: "bool", kNumber: "number"}[f.t.kind]
	}
	if !reflect.DeepEqual(types, want.Types) {
		t.Errorf("option types = %v, want %v", types, want.Types)
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
