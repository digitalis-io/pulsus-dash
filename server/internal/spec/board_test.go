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
	b, err := os.ReadFile(filepath.Join("..", "..", "..", "api", "fixtures", "board-spec", name))
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
			if _, err := DecodeBoard(raw, 2); !errors.Is(err, ErrSchemaTooNew) {
				t.Errorf("DecodeBoard(raw, 2) = %v, want ErrSchemaTooNew", err)
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
