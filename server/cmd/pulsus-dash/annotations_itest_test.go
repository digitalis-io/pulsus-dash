//go:build itest

package main

import (
	"testing"

	"github.com/digitalis-io/pulsus-dash/server/internal/store/storetest"
)

const annotationsURL = "/api/dash/v1/annotations"

// itest:annotations-entity over HTTP (T24-030, T24-031): the served routes take the new filters,
// answer the new shape and reject a bad entity filter before any statement.
func TestAnnotationsHTTP(t *testing.T) {
	for _, c := range storetest.Clusters(t) {
		t.Run(c.Name, func(t *testing.T) {
			_, cfg, env := migratedDB(t, c, "")
			s := startServe(t, cfg, env)
			s.waitReady(t)
			defer s.stop(t)
			code, _, b := do(t, s, "GET", annotationsURL+"?from=0&to=10&entity=bad", nil)
			if code != 400 || !sameJSON(t, raw(obj(t, b), "error"), []byte(`{"code":"invalid","message":"invalid request","fields":[{"pointer":"/entity","message_key":"annotations.entity.invalid"}]}`)) {
				t.Errorf("?entity=bad = %d %s, want 400 /entity annotations.entity.invalid", code, b)
			}
			body := []byte(`{"at":1764159000000,"kind":"deploy","text":"checkout v2.31","entity":{"binding":"default","kind":"service","attrs":{"service.name":"checkout"}}}`)
			code, _, b = do(t, s, "POST", annotationsURL, body)
			if code != 201 {
				t.Fatalf("create with an entity = %d %s, want 201", code, b)
			}
			id := obj(t, b)["entity"].(map[string]any)["id"].(string)
			code, _, b = do(t, s, "GET", annotationsURL+"?from=1764158400000&to=1764162000000&entity="+id, nil)
			m := obj(t, b)
			if code != 200 || !sameJSON(t, raw(m, "applied"), []byte(`{"entity":["`+id+`"]}`)) || string(raw(m, "next")) != "null" ||
				string(raw(m, "orgWideHidden")) != "0" || len(m["items"].([]any)) != 1 {
				t.Errorf("list by entity = %d %s, want the one row, applied, next null, orgWideHidden 0", code, b)
			}
		})
	}
}
