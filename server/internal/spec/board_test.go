package spec

import (
	"bytes"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"slices"
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
			// Version 6 adds the board list (#216 Part 1): the identity again.
			b6, err := DecodeBoard(raw, 6)
			if err != nil {
				t.Fatalf("DecodeBoard(raw, 6): %v", err)
			}
			if got, want := canon(t, b6), canon(t, raw); !bytes.Equal(got, want) {
				t.Errorf("DecodeBoard(raw, 6) = %s, want %s", got, want)
			}
			if _, err := DecodeBoard(raw, 7); !errors.Is(err, ErrSchemaTooNew) {
				t.Errorf("DecodeBoard(raw, 7) = %v, want ErrSchemaTooNew", err)
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
	if BoardSchemaVersion != 6 {
		t.Errorf("BoardSchemaVersion = %d, want 6", BoardSchemaVersion)
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
// items and countdown: required strings; the geomap's location, size and view: typed, required or
// optional, by v7), the nullable keys (v7) and the keys of each kind.
func TestOptionKeys(t *testing.T) {
	var want struct {
		Types         map[string]string              `json:"types"`
		Members       map[string][]string            `json:"members"`
		Kinds         map[string][]string            `json:"kinds"`
		Nullable      []string                       `json:"nullable"`
		ObjectMembers map[string]map[string][]string `json:"objectMembers"`
	}
	if err := json.Unmarshal(fixture(t, "option-keys.json"), &want); err != nil {
		t.Fatal(err)
	}
	names := map[kind]string{kString: "string", kBool: "bool", kNumber: "number", kArray: "array", kObject: "object"}
	presence := map[bool]string{true: "required", false: "optional"}
	types := map[string]string{}
	members := map[string][]string{}
	objectMembers := map[string]map[string][]string{}
	nullable := []string{}
	for _, f := range optionFields {
		types[f.name] = names[f.t.kind]
		if f.t.nullable {
			nullable = append(nullable, f.name)
		}
		shape := f.t.shape
		if f.t.kind == kArray && f.t.elem != nil {
			shape = f.t.elem.shape
		}
		if len(shape) == 0 {
			continue
		}
		if _, typed := want.ObjectMembers[f.name]; typed {
			objectMembers[f.name] = map[string][]string{}
			for _, m := range shape {
				objectMembers[f.name][m.name] = []string{names[m.t.kind], presence[m.required]}
			}
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
	if !reflect.DeepEqual(objectMembers, want.ObjectMembers) {
		t.Errorf("option object members = %v, want %v", objectMembers, want.ObjectMembers)
	}
	if !reflect.DeepEqual(nullable, want.Nullable) {
		t.Errorf("nullable options = %v, want %v", nullable, want.Nullable)
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

// v6CanonicalSHA256 is the SHA-256 of v6-board-list.json's canonical form; boards/spec.test.ts
// holds the same value, so the two canonical forms are byte-equal.
const v6CanonicalSHA256 = "f34068a04a37a48064fc82720a092473249c985e3cfd9e0f30f8103fbb7b5e87"

// unit:board-spec-board-list (#216 Part 1, T24-003, T11-016, VIZ-031): the board-list version.
// Only p-5 has a query; the fixture is valid, canonical and readable by this version only; v5
// upcasts unchanged.
func TestV6BoardListFixture(t *testing.T) {
	raw := fixture(t, "v6-board-list.json")
	b, err := ParseNewBoard(raw)
	if err != nil {
		t.Fatalf("ParseNewBoard: %v", err)
	}
	c := canon(t, b)
	if want := canon(t, raw); !bytes.Equal(c, want) {
		t.Errorf("Canonical(board) = %s\nwant Canonical(raw) = %s", c, want)
	}
	h := ContentHash(c)
	if got := hex.EncodeToString(h[:]); got != v6CanonicalSHA256 {
		t.Errorf("ContentHash = %s, want %s", got, v6CanonicalSHA256)
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
	again, err := ParseBoard(c)
	if err != nil {
		t.Fatalf("ParseBoard(canonical): %v", err)
	}
	if !reflect.DeepEqual(again, b) {
		t.Errorf("ParseBoard(Canonical(board)) = %+v, want %+v", again, b)
	}
	v5 := fixture(t, "v5-widgets.json")
	up, err := DecodeBoardUpTo(v5, 5, 6)
	if err != nil {
		t.Fatalf("DecodeBoardUpTo(v5-widgets, 5, 6): %v", err)
	}
	if got, want := canon(t, up), canon(t, v5); !bytes.Equal(got, want) {
		t.Errorf("DecodeBoardUpTo(v5-widgets, 5, 6) = %s, want %s", got, want)
	}
	if _, err := DecodeBoardUpTo(raw, 6, 5); !errors.Is(err, ErrSchemaTooNew) {
		t.Errorf("DecodeBoardUpTo(v6, 6, 5) = %v, want ErrSchemaTooNew", err)
	}
}

// unit:board-spec-geomap (#234 Part 1 §3.4, §3.5, T24 §5.15, T11-016): the geomap version. The
// fixture is valid and readable by this version only; parse, marshal and parse again give equal
// values, with every member key in lower case and present once; a null groupBy or view is stored
// absent; v6 upcasts unchanged.
func TestV7GeomapFixture(t *testing.T) {
	if BoardSchemaVersion != 7 {
		t.Errorf("BoardSchemaVersion = %d, want 7", BoardSchemaVersion)
	}
	raw := fixture(t, "v7-geomap.json")
	b, err := ParseNewBoard(raw)
	if err != nil {
		t.Fatalf("ParseNewBoard: %v", err)
	}
	if k := b.Panels[0].Vis.Kind; k != "geomap" {
		t.Errorf("panel 0 kind = %q, want geomap (itest:board-spec-old-binary)", k)
	}
	out, err := json.Marshal(b)
	if err != nil {
		t.Fatal(err)
	}
	again, err := ParseBoard(out)
	if err != nil {
		t.Fatalf("ParseBoard(marshal): %v", err)
	}
	if !reflect.DeepEqual(again, b) {
		t.Errorf("ParseBoard(Marshal(board)) = %+v, want %+v", again, b)
	}
	var m struct {
		Panels []struct {
			Vis struct {
				Options map[string]json.RawMessage `json:"options"`
			} `json:"vis"`
		} `json:"panels"`
	}
	if err := json.Unmarshal(out, &m); err != nil {
		t.Fatal(err)
	}
	keysOf := func(i int, key string) []string {
		var o map[string]json.RawMessage
		if err := json.Unmarshal(m.Panels[i].Vis.Options[key], &o); err != nil {
			t.Fatalf("panel %d %s: %v", i, key, err)
		}
		ks := make([]string, 0, len(o))
		for k := range o {
			ks = append(ks, k)
		}
		slices.Sort(ks)
		return ks
	}
	for _, c := range []struct {
		panel int
		key   string
		want  []string
	}{
		{1, "location", []string{"lat", "lon", "mode"}},
		{1, "size", []string{"by", "max", "min"}},
		{1, "view", []string{"lat", "lon", "zoom"}},
		{3, "location", []string{"field", "mode"}},
		{4, "location", []string{"field", "gazetteer", "mode"}},
		{5, "location", []string{"country", "field", "gazetteer", "mode"}},
	} {
		if got := keysOf(c.panel, c.key); !reflect.DeepEqual(got, c.want) {
			t.Errorf("panel %d %s keys = %v, want %v", c.panel, c.key, got, c.want)
		}
	}
	if n := len(m.Panels[2].Vis.Options); n != 0 {
		t.Errorf("panel 2 options = %v, want none (null is stored absent)", m.Panels[2].Vis.Options)
	}
	o := b.Panels[1].Vis.Options
	if o == nil || o.View == nil || *o.View != (GeoView{Lat: 50, Lon: 5, Zoom: 4}) {
		t.Errorf("panel 1 view = %+v", o)
	} else if o.Size == nil || *o.Size.By != "fixed" || *o.Size.Min != 6 || *o.Size.Max != 30 ||
		*o.Colour != "state" || *o.GroupBy != "env" || *o.Symbol != "diamond" || *o.Cluster || *o.WheelZoom ||
		o.Location == nil || o.Location.Mode != "coords" || *o.Location.Lat != "lat" || *o.Location.Lon != "lon" {
		t.Errorf("panel 1 options = %+v", *o)
	}
	if l := b.Panels[5].Vis.Options.Location; l == nil || *l.Country != "GB" || *l.Gazetteer != "region" || *l.Field != "r" {
		t.Errorf("panel 5 location = %+v", l)
	}
	v6 := fixture(t, "v6-board-list.json")
	up, err := DecodeBoardUpTo(v6, 6, 7)
	if err != nil {
		t.Fatalf("DecodeBoardUpTo(v6-board-list, 6, 7): %v", err)
	}
	if got, want := canon(t, up), canon(t, v6); !bytes.Equal(got, want) {
		t.Errorf("DecodeBoardUpTo(v6-board-list, 6, 7) = %s, want %s", got, want)
	}
	if _, err := DecodeBoard(v6, 6); err != nil {
		t.Errorf("DecodeBoard(v6, 6) = %v", err)
	}
	if _, err := DecodeBoardUpTo(raw, 7, 6); !errors.Is(err, ErrSchemaTooNew) {
		t.Errorf("DecodeBoardUpTo(v7, 7, 6) = %v, want ErrSchemaTooNew", err)
	}
}
