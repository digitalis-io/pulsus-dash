//go:build itest

package boards

import "github.com/digitalis-io/pulsus-dash/server/internal/store"

// newServiceWithSchemaMax is New with another newest readable schema version: the previous
// release's value decodes exactly as it did, to prove its refusal of a newer row (plan #64 Part B
// §4.7).
func newServiceWithSchemaMax(db *store.Db, schemaMax int64) *Service {
	s := New(db, nil)
	s.schemaMax = schemaMax
	return s
}

// setAfterRepair sets the hook ListBoards runs between its repair and list transactions (plan
// #215 §4); nil removes it.
func (s *Service) setAfterRepair(fn func()) { s.afterRepair = fn }
