package spec

import "strconv"

//go:generate go run gen_zones.go

// zoneExists reports whether tz is a zone of this build: a name in embeddedZones (zones_gen.go), the
// zoneinfo.zip of the toolchain that built the server, which time/tzdata embeds. The set is fixed by
// the build, the same on every replica; the host's zone database and ZONEINFO are never read. Tests
// replace it.
var zoneExists = func(tz string) bool { _, ok := embeddedZones[tz]; return ok }

// CheckZones checks that every clock zone of b exists (T24-003, plan #198 Part 1 §4.1): each tz
// other than "" and not in keep must be a zone of this build, else its /…/zones/<i>/tz is
// board.options.zones.invalid, in document order. zoneExists is asked once per distinct name. It
// returns a *ValidationError, or nil. It runs on writes only, after ParseBoard: keep is nil on a
// create, and the zones of the head on a save, so a zone already stored stays valid.
func (b Board) CheckZones(keep map[string]bool) error {
	known := map[string]bool{}
	var fields []FieldError
	check := func(pointer string, panels []Panel) {
		for i, p := range panels {
			if p.Vis.Options == nil {
				continue
			}
			for k, z := range p.Vis.Options.Zones {
				if z.TZ == "" || keep[z.TZ] {
					continue
				}
				ok, seen := known[z.TZ]
				if !seen {
					ok = zoneExists(z.TZ)
					known[z.TZ] = ok
				}
				if !ok && len(fields) < maxFieldErrors {
					fields = append(fields, FieldError{
						Pointer:    pointer + "/" + strconv.Itoa(i) + "/vis/options/zones/" + strconv.Itoa(k) + "/tz",
						MessageKey: "board.options.zones.invalid",
					})
				}
			}
		}
	}
	check("/panels", b.Panels)
	for j, s := range b.Sections {
		check("/sections/"+strconv.Itoa(j)+"/panels", s.Panels)
	}
	if len(fields) > 0 {
		return &ValidationError{Fields: fields}
	}
	return nil
}

// Zones is the set of every clock tz of b, "" included.
func (b Board) Zones() map[string]bool {
	out := map[string]bool{}
	add := func(panels []Panel) {
		for _, p := range panels {
			if p.Vis.Options != nil {
				for _, z := range p.Vis.Options.Zones {
					out[z.TZ] = true
				}
			}
		}
	}
	add(b.Panels)
	for _, s := range b.Sections {
		add(s.Panels)
	}
	return out
}

// ParseNewBoard is ParseBoard for a spec with no stored head (a create): every clock zone must also
// exist (CheckZones(nil)).
func ParseNewBoard(raw []byte) (Board, error) {
	b, err := ParseBoard(raw)
	if err != nil {
		return Board{}, err
	}
	if err := b.CheckZones(nil); err != nil {
		return Board{}, err
	}
	return b, nil
}
