package spec

import (
	"regexp"
	"slices"
	"strconv"
	"strings"
	"unicode/utf8"
)

// Limits of the board spec v1 (plan #61 §3.4.3; SRF-019 for the panel count).
const (
	maxTitleRunes  = 200
	maxSections    = 50
	maxPanels      = 200
	maxQueryBytes  = 16384
	gridColumns    = 12
	maxGridRow     = 9999
	maxGridRowSpan = 100
)

var (
	timePattern = regexp.MustCompile(`^(now|now/d|now-[1-9][0-9]{0,4}[smhdw]|\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{3})?)?(Z|[+-]\d{2}:\d{2}))$`)
	idPattern   = regexp.MustCompile(`^[a-z0-9-]{1,40}$`)
	queryLangs  = []string{"promql", "logql"}
	visKinds    = []string{"auto", "line", "bars", "heatmap", "stat", "logs"}
)

// validator collects field errors in document order, at most maxFieldErrors.
type validator struct {
	fields []FieldError
	ids    map[string]bool // panel and section ids share one namespace
}

func (v *validator) add(pointer, key string) {
	if len(v.fields) < maxFieldErrors {
		v.fields = append(v.fields, FieldError{Pointer: pointer, MessageKey: key})
	}
}

// str checks a string: U+0000 (which jsonb rejects) first, then rule, which returns a message
// key or "".
func (v *validator) str(pointer, s string, rule func(string) string) {
	if strings.ContainsRune(s, 0) {
		v.add(pointer, "board.string.nul")
		return
	}
	if key := rule(s); key != "" {
		v.add(pointer, key)
	}
}

func maxRunes(key string) func(string) string {
	return func(s string) string {
		if utf8.RuneCountInString(s) > maxTitleRunes {
			return key
		}
		return ""
	}
}

func oneOf(set []string, key string) func(string) string {
	return func(s string) string {
		if !slices.Contains(set, s) {
			return key
		}
		return ""
	}
}

func (v *validator) id(pointer, id string) {
	v.str(pointer, id, func(s string) string {
		switch {
		case !idPattern.MatchString(s):
			return "board.id.invalid"
		case v.ids[s]:
			return "board.id.duplicate"
		}
		v.ids[s] = true
		return ""
	})
}

// Validate checks the semantic rules of plan #61 §3.4.3 and returns a *ValidationError, or nil.
// Errors are in document order: title, time, panels, sections, each panel in field order.
func (b Board) Validate() error {
	v := &validator{ids: map[string]bool{}}
	v.str("/title", b.Title, func(s string) string {
		if strings.TrimSpace(s) == "" {
			return "board.title.required"
		}
		return maxRunes("board.title.tooLong")(s)
	})
	if b.Time != nil {
		valid := func(s string) string {
			if !timePattern.MatchString(s) {
				return "board.time.invalid"
			}
			return ""
		}
		v.str("/time/from", b.Time.From, valid)
		v.str("/time/to", b.Time.To, valid)
	}
	total := len(b.Panels)
	for _, s := range b.Sections {
		total += len(s.Panels)
	}
	if total > maxPanels {
		v.add("/panels", "board.panels.tooMany")
	}
	v.panels("/panels", b.Panels)
	if len(b.Sections) > maxSections {
		v.add("/sections", "board.sections.tooMany")
	}
	for j, s := range b.Sections {
		p := "/sections/" + strconv.Itoa(j)
		v.id(p+"/id", s.ID)
		v.str(p+"/title", s.Title, maxRunes("board.section.title.tooLong"))
		v.panels(p+"/panels", s.Panels)
	}
	if len(v.fields) > 0 {
		return &ValidationError{Fields: v.fields}
	}
	return nil
}

func inBounds(g Grid) bool {
	return g.X >= 0 && g.X < gridColumns && g.W >= 1 && g.W <= gridColumns && g.X+g.W <= gridColumns &&
		g.Y >= 0 && g.Y <= maxGridRow && g.H >= 1 && g.H <= maxGridRowSpan
}

func overlap(a, b Grid) bool {
	return a.X < b.X+b.W && b.X < a.X+a.W && a.Y < b.Y+b.H && b.Y < a.Y+a.H
}

// panels checks the panels of one grid (the top level or one section).
func (v *validator) panels(pointer string, panels []Panel) {
	placed := make([]Grid, 0, len(panels))
	for i, p := range panels {
		pp := pointer + "/" + strconv.Itoa(i)
		v.id(pp+"/id", p.ID)
		v.str(pp+"/title", p.Title, maxRunes("board.panel.title.tooLong"))
		switch {
		case !inBounds(p.Grid):
			v.add(pp+"/grid", "board.grid.outOfBounds")
		case slices.ContainsFunc(placed, func(g Grid) bool { return overlap(g, p.Grid) }):
			v.add(pp+"/grid", "board.grid.overlap")
		default:
			placed = append(placed, p.Grid)
		}
		v.str(pp+"/query/lang", p.Query.Lang, oneOf(queryLangs, "board.query.lang.invalid"))
		v.str(pp+"/query/text", p.Query.Text, func(s string) string {
			if len(s) > maxQueryBytes {
				return "board.query.text.tooLong"
			}
			return ""
		})
		v.str(pp+"/vis/kind", p.Vis.Kind, oneOf(visKinds, "board.vis.kind.invalid"))
	}
}
