package entity

import (
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"reflect"
	"testing"

	"github.com/google/uuid"
)

const fixturePath = "../../../wire/fixtures/json/entity-id.json"

type fixtureBinding struct {
	ID   uuid.UUID `json:"id"`
	Slug string    `json:"slug"`
}

type validCase struct {
	Name      string                     `json:"name"`
	Binding   string                     `json:"binding"`
	Kind      string                     `json:"kind"`
	Attrs     map[string]json.RawMessage `json:"attrs"`
	CanonLen  int                        `json:"canonLen"`
	Ident     []*string                  `json:"ident"`
	Canonical map[string]string          `json:"canonical"`
	ID        string                     `json:"id"`
	CanonHex  string                     `json:"canonHex"`
}

type invalidCase struct {
	Name  string                     `json:"name"`
	Kind  string                     `json:"kind"`
	Attrs map[string]json.RawMessage `json:"attrs"`
}

type fixture struct {
	Bindings map[string]fixtureBinding `json:"bindings"`
	Valid    []validCase               `json:"valid"`
	Invalid  []invalidCase             `json:"invalid"`
}

func loadFixture(t *testing.T) fixture {
	t.Helper()
	b, err := os.ReadFile(fixturePath)
	if err != nil {
		t.Fatal(err)
	}
	var f fixture
	if err := json.Unmarshal(b, &f); err != nil {
		t.Fatal(err)
	}
	if len(f.Valid) == 0 || len(f.Invalid) == 0 {
		t.Fatal("empty fixture")
	}
	return f
}

// unit:entity-id (T12-010): every T12 §4.5 vector canonicalises to its canonical map and id; the
// invalid entities are ErrInvalid.
func TestEntityID(t *testing.T) {
	f := loadFixture(t)
	ids := map[string]string{}
	for _, c := range f.Valid {
		t.Run(c.Name, func(t *testing.T) {
			b, ok := f.Bindings[c.Binding]
			if !ok {
				t.Fatalf("unknown binding %q", c.Binding)
			}
			got, err := Canonicalise(c.Kind, c.Attrs)
			if err != nil {
				t.Fatalf("Canonicalise = %v", err)
			}
			if got.Kind != c.Kind || !reflect.DeepEqual(got.Ident, c.Ident) || !reflect.DeepEqual(got.Attrs, c.Canonical) {
				t.Errorf("canonical = %+v (ident %s), want ident %s attrs %v", got, js(got.Ident), js(c.Ident), c.Canonical)
			}
			canon := Canon(b.ID, got)
			if len(canon) != c.CanonLen {
				t.Errorf("len(Canon) = %d, want %d", len(canon), c.CanonLen)
			}
			if c.CanonHex != "" && hex.EncodeToString(canon) != c.CanonHex {
				t.Errorf("Canon = %x, want %s", canon, c.CanonHex)
			}
			if id := ID(b.ID, got).String(); id != c.ID {
				t.Errorf("ID = %s, want %s", id, c.ID)
			}
			ids[c.Name] = ID(b.ID, got).String()
		})
	}
	if ids["payments@e1"] == "" || ids["payments@e1"] != ids["payments@e1 reversed"] {
		t.Errorf("payments@e1 in both key orders: %q and %q", ids["payments@e1"], ids["payments@e1 reversed"])
	}
	for _, c := range f.Invalid {
		t.Run("invalid "+c.Name, func(t *testing.T) {
			if got, err := Canonicalise(c.Kind, c.Attrs); !errors.Is(err, ErrInvalid) {
				t.Errorf("Canonicalise = %+v, %v; want ErrInvalid", got, err)
			}
		})
	}
}

func js(v any) string {
	b, _ := json.Marshal(v)
	return string(b)
}
