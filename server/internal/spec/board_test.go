package spec

import (
	"bytes"
	"encoding/hex"
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
			if _, err := DecodeBoard(raw, 3); !errors.Is(err, ErrSchemaTooNew) {
				t.Errorf("DecodeBoard(raw, 3) = %v, want ErrSchemaTooNew", err)
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
	if BoardSchemaVersion != 2 {
		t.Errorf("BoardSchemaVersion = %d, want 2", BoardSchemaVersion)
	}
}
