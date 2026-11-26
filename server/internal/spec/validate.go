package spec

import (
	"math"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"unicode/utf8"
)

// Limits of the board spec (plan #61 §3.4.3; SRF-019 for the panel count; plan #64 Part B §3.1 for
// thresholds).
const (
	maxThresholdSteps = 8
	// minThresholdAbs and maxThresholdAbs bound a non-zero threshold value: far inside the range
	// where the value axis ticks are safe at both ends (#97). The client's MIN_THRESHOLD_ABS and
	// MAX_THRESHOLD_ABS have the same values.
	minThresholdAbs = 1e-9
	maxThresholdAbs = 1e15

	maxTitleRunes  = 200
	maxSections    = 50
	maxPanels      = 200
	maxQueryBytes  = 16384
	gridColumns    = 12
	maxGridRow     = 9999
	maxGridRowSpan = 100
	// maxBoardTags bounds a board's tags (T24-029), as AnnotationTag lists.
	maxBoardTags = 16
)

var (
	timePattern = regexp.MustCompile(`^(now|now/d|now-[1-9][0-9]{0,4}[smhdw]|\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{3})?)?(Z|[+-]\d{2}:\d{2}))$`)
	idPattern   = regexp.MustCompile(`^[a-z0-9-]{1,40}$`)
	// tagPattern is the OpenAPI AnnotationTag (the gateway's tagPattern, the client's TAG_PATTERN).
	tagPattern  = regexp.MustCompile(`^[a-z0-9][a-z0-9_.:/-]{0,63}$`)
	queryLangs  = []string{"promql", "logql"}
	visKinds    = []string{"auto", "line", "bars", "heatmap", "stat", "logs", "barchart", "pie"}
	directions  = []string{"above", "below"}
	stepStates  = []string{"watch", "degraded", "failing"}
	legendModes = []string{"table", "hidden"}

	// The option values of board spec v3 (T22 §6.1; client boards/options.ts OPTION_VALUES).
	// labelPattern is the client's FILTER_LABEL.
	labelPattern    = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_.]{0,99}$`)
	reducers        = []string{"last", "first", "mean", "min", "max", "sum", "count"}
	baselineOffsets = []string{"1h", "1d", "7d", "28d"}
	sorts           = []string{"valueDesc", "valueAsc", "label", "none"}
	orientations    = []string{"horizontal", "vertical"}
	statOrients     = []string{"auto", "horizontal", "vertical"}
	pieLabels       = []string{"percent", "value", "name", "none"}
	layouts         = []string{"single", "grid"}
	colourModes     = []string{"value", "background", "none"}
	textModes       = []string{"auto", "value", "valueAndName", "name"}
	graphModes      = []string{"sparkline", "none"}
)

// maxOptionAbs bounds options.min and options.max (|v| <= 1e15, as the threshold values).
const maxOptionAbs = 1e15

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
// Errors are in document order: title, time, tags, panels, sections, each panel in field order.
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
	v.tags(b.Tags)
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

// tags checks a board's tags (T24-029): at most 16 (reported at /tags), then each item, which
// must match tagPattern and differ from every earlier item.
func (v *validator) tags(tags []string) {
	if len(tags) > maxBoardTags {
		v.add("/tags", "board.tags.invalid")
	}
	for i, tag := range tags {
		v.str("/tags/"+strconv.Itoa(i), tag, func(s string) string {
			switch {
			case !tagPattern.MatchString(s):
				return "board.tags.invalid"
			case slices.Contains(tags[:i], s):
				return "board.tags.duplicate"
			}
			return ""
		})
	}
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
		if p.Query != nil {
			v.str(pp+"/query/lang", p.Query.Lang, oneOf(queryLangs, "board.query.lang.invalid"))
			v.str(pp+"/query/text", p.Query.Text, func(s string) string {
				if len(s) > maxQueryBytes {
					return "board.query.text.tooLong"
				}
				return ""
			})
		}
		v.str(pp+"/vis/kind", p.Vis.Kind, oneOf(visKinds, "board.vis.kind.invalid"))
		v.vis(pp+"/vis", p.Vis)
	}
}

// inThresholdRange reports whether a threshold value is 0 (-0 included) or has a magnitude in
// [minThresholdAbs, maxThresholdAbs]. The shape pass has already made it finite.
func inThresholdRange(x float64) bool {
	a := math.Abs(x)
	return x == 0 || (a >= minThresholdAbs && a <= maxThresholdAbs)
}

// vis checks a panel's thresholds and legend (plan #64 Part B §3.1), after vis.kind, then its
// options (board spec v3) when the kind is valid. Thresholds are valid on every kind; every step is
// checked, even past 8.
func (v *validator) vis(pointer string, vis Vis) {
	if t := vis.Thresholds; t != nil {
		tp := pointer + "/thresholds"
		v.str(tp+"/direction", t.Direction, oneOf(directions, "board.thresholds.direction.invalid"))
		if len(t.Steps) == 0 || len(t.Steps) > maxThresholdSteps {
			v.add(tp+"/steps", "board.thresholds.steps.count")
		}
		for k, s := range t.Steps {
			sp := tp + "/steps/" + strconv.Itoa(k)
			switch {
			case !inThresholdRange(s.Value):
				v.add(sp+"/value", "board.thresholds.value.range")
			case slices.ContainsFunc(t.Steps[:k], func(e ThresholdStep) bool { return e.Value == s.Value }):
				v.add(sp+"/value", "board.thresholds.value.duplicate")
			}
			v.str(sp+"/state", s.State, oneOf(stepStates, "board.thresholds.state.invalid"))
			v.str(sp+"/label", s.Label, maxRunes("board.thresholds.label.tooLong"))
		}
	}
	if l := vis.Legend; l != nil {
		v.str(pointer+"/legend/mode", l.Mode, oneOf(legendModes, "board.legend.mode.invalid"))
	}
	if vis.Options != nil && slices.Contains(visKinds, vis.Kind) {
		v.options(pointer+"/options", vis.Kind, *vis.Options)
	}
}

func optionKey(key string) string { return "board.options." + key + ".invalid" }

// options checks the values of a kind's options (plan #173 Part 1 §3.4), each present key in
// OPTION_ORDER: strings through str, then the key's rule. The shape pass has allowed only the
// kind's keys and made min and max finite. min >= max is reported at max, only when min is valid.
func (v *validator) options(pointer, kind string, o Options) {
	enum := func(name string, s *string, set []string) {
		if s != nil {
			v.str(pointer+"/"+name, *s, oneOf(set, optionKey(name)))
		}
	}
	bound := func(x float64) bool { return math.Abs(x) <= maxOptionAbs }
	enum("reducer", o.Reducer, reducers)
	enum("baselineOffset", o.BaselineOffset, baselineOffsets)
	if o.CategoryBy != nil {
		v.str(pointer+"/categoryBy", *o.CategoryBy, func(s string) string {
			if s != "" && !labelPattern.MatchString(s) {
				return optionKey("categoryBy")
			}
			return ""
		})
	}
	enum("sort", o.Sort, sorts)
	if kind == "stat" {
		enum("orientation", o.Orientation, statOrients)
	} else {
		enum("orientation", o.Orientation, orientations)
	}
	minValid := o.Min != nil && bound(*o.Min)
	if o.Min != nil && !minValid {
		v.add(pointer+"/min", optionKey("min"))
	}
	if o.Max != nil && (!bound(*o.Max) || (minValid && *o.Min >= *o.Max)) {
		v.add(pointer+"/max", optionKey("max"))
	}
	enum("labels", o.Labels, pieLabels)
	enum("layout", o.Layout, layouts)
	enum("colourMode", o.ColourMode, colourModes)
	if o.TextMode != nil {
		grid := o.Layout != nil && *o.Layout == "grid"
		v.str(pointer+"/textMode", *o.TextMode, func(s string) string {
			if !slices.Contains(textModes, s) || (grid && s == "value") {
				return optionKey("textMode")
			}
			return ""
		})
	}
	enum("graphMode", o.GraphMode, graphModes)
}
