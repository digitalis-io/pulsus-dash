//go:build itest

package main

import (
	"encoding/json"
	"os"
	"strconv"
	"testing"

	"github.com/digitalis-io/pulsus-dash/server/internal/spec"
	"github.com/digitalis-io/pulsus-dash/server/internal/store"
	"github.com/digitalis-io/pulsus-dash/server/internal/store/storetest"
)

// oldSpecVersion is DASH_OLD_SPEC_VERSION, the board spec version of the previous release that
// make itest-old-binary builds (its spec.BoardSchemaVersion).
func oldSpecVersion(t *testing.T) int64 {
	t.Helper()
	v, err := strconv.ParseInt(os.Getenv("DASH_OLD_SPEC_VERSION"), 10, 64)
	if err != nil || v < 1 {
		t.Fatalf("DASH_OLD_SPEC_VERSION %q is not a positive integer", os.Getenv("DASH_OLD_SPEC_VERSION"))
	}
	return v
}

// oldFixture is DASH_OLD_FIXTURE: the previous release's own fixture of its spec version (the
// first, by name, of v<P>-*.json in its tree).
func oldFixture(t *testing.T) []byte {
	t.Helper()
	p := os.Getenv("DASH_OLD_FIXTURE")
	if p == "" {
		t.Fatal("DASH_OLD_FIXTURE is not set")
	}
	b, err := os.ReadFile(p) //nolint:gosec // the previous release's fixture (make itest-old-binary)
	if err != nil {
		t.Fatalf("DASH_OLD_FIXTURE: %v", err)
	}
	return b
}

// firstField is the first field error of a 400 invalid body, as "pointer key".
func firstField(t *testing.T, b []byte) string {
	t.Helper()
	e, _ := obj(t, b)["error"].(map[string]any)
	fields, _ := e["fields"].([]any)
	if len(fields) == 0 {
		return ""
	}
	f, _ := fields[0].(map[string]any)
	p, _ := f["pointer"].(string)
	k, _ := f["message_key"].(string)
	return p + " " + k
}

// newFixture is this release's fixture of its newest spec version (v8, the units version, #290),
// whose first panel has the newest key, vis.unit; oldRefusal is the previous release's first field
// error for it (a v7 binary knows no vis.unit, T05 §7.1).
const (
	newFixture = "v8-units.json"
	oldRefusal = "/panels/0/vis/unit board.json.unknownKey"
)

// withNewestKind is spec with a panel of the newest version's shape (a line with a unit) added
// below its top-level panels.
func withNewestKind(t *testing.T, raw []byte) []byte {
	t.Helper()
	var s map[string]any
	if err := json.Unmarshal(raw, &s); err != nil {
		t.Fatal(err)
	}
	panels, _ := s["panels"].([]any)
	bottom := 0.0
	for _, p := range panels {
		g, _ := p.(map[string]any)["grid"].(map[string]any)
		y, _ := g["y"].(float64)
		h, _ := g["h"].(float64)
		bottom = max(bottom, y+h)
	}
	s["panels"] = append(panels, map[string]any{"id": "unit-newest", "title": "Uptime",
		"grid":  map[string]any{"x": 0, "y": bottom, "w": 4, "h": 4},
		"query": map[string]any{"lang": "promql", "text": "up"},
		"vis":   map[string]any{"kind": "line", "unit": map[string]any{"id": "seconds"}}})
	b, err := json.Marshal(s)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

// itest:board-spec-old-binary (T11-015, T11-016; plan #198 Part 1 §4.4, plan #216 Part 1 §4.5): the
// previous release, at an older board spec version, beside this one on one database. It cannot
// read or overwrite a head this release saved at the newest version, refuses a spec of the newest
// kind on its own writes, and keeps working.
func TestBoardSpecOldBinary(t *testing.T) {
	bin := oldBinary(t)
	if oldSpecVersion(t) == spec.BoardSchemaVersion {
		t.Skip("the board spec version is unchanged")
	}
	for _, c := range storetest.Clusters(t) {
		t.Run(c.Name, func(t *testing.T) {
			ctx := itestCtx(t)
			db := storetest.NewDB(t, c)
			// 1 migrate with this release; start the previous release and this one.
			if _, err := store.Migrate(ctx, db.OwnerURL, store.MigrateOptions{Seed: staticSeed}); err != nil {
				t.Fatalf("migrate: %v", err)
			}
			old := startOld(t, bin, db)
			cfg, env := dbConfig(t, db, seedYAML)
			n := startServe(t, cfg, env)
			n.waitReady(t)
			versionsOf := func(uid string) int64 {
				return storetest.QueryInt(t, db.SuperURL, "SELECT count(*) FROM board_versions v JOIN boards b ON b.org_id = v.org_id AND b.id = v.board_id WHERE b.uid = $1", uid)
			}
			headOf := func(uid string) string {
				return storetest.QueryString(t, db.SuperURL, "SELECT encode(v.content_hash, 'hex') FROM boards b JOIN board_versions v ON v.org_id = b.org_id AND v.board_id = b.id AND v.version = b.head_version WHERE b.uid = $1", uid)
			}
			const tooNew = "board saved by a newer server version"

			// 2 this release creates W from the newest fixture; it stores the parsed board, so a
			// null option (v7: groupBy, view) is read back absent.
			w := specFixture(t, newFixture)
			parsedW, err := spec.ParseBoard(w)
			if err != nil {
				t.Fatal(err)
			}
			canonW, err := spec.Canonical(parsedW)
			if err != nil {
				t.Fatal(err)
			}
			code, _, b := do(t, n, "POST", boardsURL, []byte(`{"spec":`+string(w)+`}`))
			if code != 201 {
				t.Fatalf("N create W = %d %s", code, b)
			}
			wUID, _ := obj(t, b)["uid"].(string)
			code, _, b = do(t, n, "GET", boardsURL+"/"+wUID, nil)
			if m := obj(t, b); code != 200 || m["schema_version"] != float64(spec.BoardSchemaVersion) || string(raw(m, "spec")) != string(canonW) {
				t.Errorf("N get W = %d %s, want schema_version %d and the canonical fixture", code, b, spec.BoardSchemaVersion)
			}

			// 3 the previous release cannot read or overwrite W, and still lists it.
			if code, _, b := doAt(t, old, "GET", boardsURL+"/"+wUID, nil); code != 503 || errMsg(t, b) != tooNew {
				t.Errorf("old get W = %d %s, want 503 %s", code, b, tooNew)
			}
			// A spec of its own version (its own fixture): only the stored head refuses the save.
			vSpec := oldFixture(t)
			if code, _, b := doAt(t, old, "PUT", boardsURL+"/"+wUID, []byte(`{"spec":`+string(vSpec)+`}`), "If-Match", `"1"`); code != 503 || errMsg(t, b) != tooNew {
				t.Errorf("old save W = %d %s, want 503 %s", code, b, tooNew)
			}
			if v := versionsOf(wUID); v != 1 {
				t.Errorf("W has %d versions, want 1", v)
			}
			code, _, b = doAt(t, old, "GET", boardsURL, nil)
			listed := false
			items, _ := obj(t, b)["items"].([]any)
			for _, it := range items {
				if m, _ := it.(map[string]any); m["uid"] == wUID {
					listed = true
				}
			}
			if code != 200 || !listed {
				t.Errorf("old list = %d %s, want W listed", code, b)
			}

			// 4 the previous release refuses W's spec on create.
			if code, _, b := doAt(t, old, "POST", boardsURL, []byte(`{"spec":`+string(w)+`}`)); code != 400 || firstField(t, b) != oldRefusal {
				t.Errorf("old create of W's spec = %d %s, want 400 %s", code, b, oldRefusal)
			}

			// 5 the previous release creates V from its own fixture and cannot save W's spec over
			// it; this release reads V, saves it with a panel of the newest shape, and the previous
			// release is then refused.
			code, _, b = doAt(t, old, "POST", boardsURL, []byte(`{"spec":`+string(vSpec)+`}`))
			if code != 201 {
				t.Fatalf("old create V = %d %s", code, b)
			}
			vUID, _ := obj(t, b)["uid"].(string)
			before := headOf(vUID)
			if code, _, b := doAt(t, old, "PUT", boardsURL+"/"+vUID, []byte(`{"spec":`+string(w)+`}`), "If-Match", `"1"`); code != 400 || firstField(t, b) != oldRefusal {
				t.Errorf("old save of W's spec over V = %d %s, want 400 %s", code, b, oldRefusal)
			}
			if after, v := headOf(vUID), versionsOf(vUID); after != before || v != 1 {
				t.Errorf("V head %s with %d versions, want %s with 1", after, v, before)
			}
			// The previous release stored V parsed, so a null option of its fixture (v7-geomap.json:
			// groupBy, view) is read back absent.
			parsedV, err := spec.ParseBoard(vSpec)
			if err != nil {
				t.Fatal(err)
			}
			canonV, err := spec.Canonical(parsedV)
			if err != nil {
				t.Fatal(err)
			}
			code, _, b = do(t, n, "GET", boardsURL+"/"+vUID, nil)
			if m := obj(t, b); code != 200 || m["schema_version"] != float64(spec.BoardSchemaVersion) || string(raw(m, "spec")) != string(canonV) {
				t.Errorf("N get V = %d %s, want schema_version %d and V's canonical spec", code, b, spec.BoardSchemaVersion)
			}
			if code, _, b := do(t, n, "PUT", boardsURL+"/"+vUID, []byte(`{"spec":`+string(withNewestKind(t, canonV))+`}`), "If-Match", `"1"`); code != 200 {
				t.Errorf("N save V with a unit = %d %s, want 200", code, b)
			}
			if code, _, b := doAt(t, old, "GET", boardsURL+"/"+vUID, nil); code != 503 || errMsg(t, b) != tooNew {
				t.Errorf("old get V = %d %s, want 503 %s", code, b, tooNew)
			}

			// 6 the previous release's own round trip still passes.
			boardCRUD(t, old, nil)
			n.stop(t)
		})
	}
}
