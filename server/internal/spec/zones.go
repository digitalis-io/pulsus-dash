package spec

// embeddedZones: stub until the implementation (zones_gen.go).
var embeddedZones = map[string]struct{}{}

var zoneExists = func(tz string) bool { _, ok := embeddedZones[tz]; return ok }

// CheckZones: stub.
func (b Board) CheckZones(keep map[string]bool) error { return nil }

// Zones: stub.
func (b Board) Zones() map[string]bool { return nil }

// ParseNewBoard: stub.
func ParseNewBoard(raw []byte) (Board, error) { return ParseBoard(raw) }

func validRFC3339Offset(s string) bool { return false }
