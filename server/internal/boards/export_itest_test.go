//go:build itest

package boards

import "github.com/digitalis-io/pulsus-dash/server/internal/store"

// newServiceWithSchemaMax is New with another newest readable schema version: 1 decodes exactly
// as the previous release did, to prove its refusal of a newer row (plan #64 Part B §4.7).
func newServiceWithSchemaMax(db *store.Db, schemaMax int64) *Service {
	s := New(db)
	s.schemaMax = schemaMax
	return s
}
