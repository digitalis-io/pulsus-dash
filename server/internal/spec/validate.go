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

	// The widget bounds of board spec v5 (T24 §5.1; the client's MAX_CONTENT_BYTES, MAX_ZONES).
	maxContentBytes   = 65536 // a text's content, UTF-8 bytes
	maxZones          = 12    // a clock's zones
	maxZoneNameBytes  = 64    // a zone's tz
	maxWidgetLabelLen = 64    // a zone's label and a countdown's label, runes

	// The board list bounds of board spec v6 (T24 §5.5; the client's MAX_BOARD_QUERY, BOARD_LIMIT).
	maxBoardQueryRunes = 100 // a board list's search text, runes (the gateway's maxSearchRunes)
	minBoardLimit      = 1   // a board list's rows
	maxBoardLimit      = 50
)

var (
	timePattern = regexp.MustCompile(`^(now|now/d|now-[1-9][0-9]{0,4}[smhdw]|\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{3})?)?(Z|[+-]\d{2}:\d{2}))$`)
	idPattern   = regexp.MustCompile(`^[a-z0-9-]{1,40}$`)
	// tagPattern is the OpenAPI AnnotationTag (the gateway's tagPattern, the client's TAG_PATTERN).
	tagPattern = regexp.MustCompile(`^[a-z0-9][a-z0-9_.:/-]{0,63}$`)
	queryLangs = []string{"promql", "logql"}
	visKinds   = []string{"auto", "line", "bars", "heatmap", "stat", "logs", "barchart", "pie", "text", "clock", "boardList", "geomap"}
	// widgetKinds are the kinds without a query (board spec v5, T24-003; boardList by v6); the
	// others in visKinds are data panels.
	widgetKinds = []string{"text", "clock", "boardList"}
	directions  = []string{"above", "below"}
	stepStates  = []string{"watch", "degraded", "failing"}
	legendModes = []string{"table", "hidden"}
	// unitIDs: stub (tests first, #290).
	unitIDs = []string{}

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

	// The widget option values of board spec v5 (T24 §5.1; client OPTION_VALUES). tzName is the
	// client's TZ_NAME; rfc3339Offset is countdown.to's grammar, before validRFC3339Offset's ranges.
	markupModes   = []string{"markdown", "code"}
	codeLanguages = []string{"plaintext", "json", "yaml", "sql", "promql", "logql", "go", "shell"}
	hourCycles    = []string{"auto", "h12", "h23"}
	afterModes    = []string{"countUp", "hide"}
	tzName        = regexp.MustCompile(`^[A-Za-z][A-Za-z0-9_+-]*(/[A-Za-z0-9_+-]+)*$`)
	rfc3339Offset = regexp.MustCompile(`^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d{1,9})?(Z|[+-](\d{2}):(\d{2}))$`)

	// The board list option values of board spec v6 (T24 §5.5; client OPTION_VALUES boardListMode
	// and boardListSort). mode and sort are shared keys: each kind has its own values.
	boardListModes = []string{"starred", "recent", "search", "tag"}
	boardListSorts = []string{"default", "incidents"}

	// The geomap option values of board spec v7 (T24 §5.15; client OPTION_VALUES). labels is shared
	// with pie: each kind has its own values. countryPattern is a region's country prefix.
	geomapLabels   = []string{"auto", "none"}
	gazetteers     = []string{"country", "region", "iata", "cloud"}
	sizeBys        = []string{"value", "fixed"}
	colours        = []string{"group", "state"}
	symbols        = []string{"circle", "square", "triangle", "diamond"}
	countryPattern = regexp.MustCompile(`^[A-Z]{2}$`)
)

// The geomap's size and view bounds (board spec v7, ADR-0027; the client's GEO_SIZE, GEO_VIEW).
const (
	geoSizeMin        = 2
	geoSizeMax        = 40
	geoSizeDefaultMin = 4
	geoSizeDefaultMax = 20
	geoMaxLat         = 85.0511
	geoMaxZoom        = 14
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
		// Board spec v5 (T24-003): a widget has no query and a data panel needs one; a panel of an
		// invalid kind reports only its kind.
		widget := slices.Contains(widgetKinds, p.Vis.Kind)
		switch {
		case p.Query != nil && widget:
			v.add(pp+"/query", "board.panel.query.forbidden")
		case p.Query == nil && slices.Contains(visKinds, p.Vis.Kind) && !widget:
			v.add(pp+"/query", "board.panel.query.required")
		case p.Query != nil:
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
// options (board spec v3) when the kind is valid. Thresholds are valid on every data kind; every step
// is checked, even past 8. A widget has neither thresholds nor legend (board spec v5): each is an
// unknown key, reported here because the shape pass cannot know a kind that comes later.
func (v *validator) vis(pointer string, vis Vis) {
	widget := slices.Contains(widgetKinds, vis.Kind)
	if vis.Thresholds != nil && widget {
		v.add(pointer+"/thresholds", keyUnknownKey)
	}
	if vis.Legend != nil && widget {
		v.add(pointer+"/legend", keyUnknownKey)
	}
	if t := vis.Thresholds; t != nil && !widget {
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
	if l := vis.Legend; l != nil && !widget {
		v.str(pointer+"/legend/mode", l.Mode, oneOf(legendModes, "board.legend.mode.invalid"))
	}
	if vis.Options != nil && slices.Contains(visKinds, vis.Kind) {
		v.options(pointer+"/options", vis.Kind, *vis.Options)
		if vis.Kind == "geomap" {
			v.geomapOptions(pointer+"/options", *vis.Options, vis.Thresholds != nil && len(vis.Thresholds.Steps) > 0)
		}
	}
}

// geomapOptions checks a geomap's own keys (board spec v7, T24 §5.15), after the shared ones, in
// OPTION_ORDER, each with one error at its key: location (validLocation), size (by value or fixed,
// 2 <= min <= max <= 40 with the defaults 4 and 20), colour (state only with a threshold step),
// groupBy (a label key; null is none), symbol and view (|lat| <= 85.0511, -180 <= lon < 180, 0 <=
// zoom <= 14; null is none). The shape pass has typed every member and made the numbers finite.
func (v *validator) geomapOptions(pointer string, o Options, steps bool) {
	if o.Location != nil && !validLocation(*o.Location) {
		v.add(pointer+"/location", optionKey("location"))
	}
	if s := o.Size; s != nil {
		lo, hi := float64(geoSizeDefaultMin), float64(geoSizeDefaultMax)
		if s.Min != nil {
			lo = *s.Min
		}
		if s.Max != nil {
			hi = *s.Max
		}
		by := s.By == nil || slices.Contains(sizeBys, *s.By)
		if !by || lo < geoSizeMin || lo > hi || hi > geoSizeMax {
			v.add(pointer+"/size", optionKey("size"))
		}
	}
	if o.Colour != nil {
		v.str(pointer+"/colour", *o.Colour, func(s string) string {
			if !slices.Contains(colours, s) || (s == "state" && !steps) {
				return optionKey("colour")
			}
			return ""
		})
	}
	if o.GroupBy != nil {
		v.str(pointer+"/groupBy", *o.GroupBy, func(s string) string {
			if !labelPattern.MatchString(s) {
				return optionKey("groupBy")
			}
			return ""
		})
	}
	if o.Symbol != nil {
		v.str(pointer+"/symbol", *o.Symbol, oneOf(symbols, optionKey("symbol")))
	}
	if w := o.View; w != nil && (math.Abs(w.Lat) > geoMaxLat || w.Lon < -180 || w.Lon >= 180 || w.Zoom < 0 || w.Zoom > geoMaxZoom) {
		v.add(pointer+"/view", optionKey("view"))
	}
}

// validLocation reports whether a geomap's location is valid (the client's validLocation, T24
// §5.11): a listed mode with exactly its members (coords lat and lon, geohash field, lookup field
// and gazetteer, and country only for the region gazetteer), each label key a labelPattern key,
// the gazetteer listed and the country two upper-case letters.
func validLocation(l GeoLocation) bool {
	label := func(s *string) bool { return s != nil && labelPattern.MatchString(*s) }
	switch l.Mode {
	case "auto":
		return l.Lat == nil && l.Lon == nil && l.Field == nil && l.Gazetteer == nil && l.Country == nil
	case "coords":
		return label(l.Lat) && label(l.Lon) && l.Field == nil && l.Gazetteer == nil && l.Country == nil
	case "geohash":
		return label(l.Field) && l.Lat == nil && l.Lon == nil && l.Gazetteer == nil && l.Country == nil
	case "lookup":
		region := l.Gazetteer != nil && *l.Gazetteer == "region"
		return label(l.Field) && l.Gazetteer != nil && slices.Contains(gazetteers, *l.Gazetteer) &&
			l.Lat == nil && l.Lon == nil && (l.Country == nil || (region && countryPattern.MatchString(*l.Country)))
	}
	return false
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
	if kind == "boardList" {
		enum("sort", o.Sort, boardListSorts)
	} else {
		enum("sort", o.Sort, sorts)
	}
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
	if kind == "geomap" {
		enum("labels", o.Labels, geomapLabels)
	} else {
		enum("labels", o.Labels, pieLabels)
	}
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
	v.widgetOptions(pointer, kind, o)
	if kind == "boardList" {
		v.boardListOptions(pointer, o)
	}
}

// widgetOptions checks the text and clock options (board spec v5, T24 §5.1), each present key in
// OPTION_ORDER after the data keys; mode takes the kind's values (text, or the board list's by v6).
// Zone existence is not checked here (CheckZones, on writes only).
func (v *validator) widgetOptions(pointer, kind string, o Options) {
	key := func(rule string) string { return "board.options." + rule }
	if o.Mode != nil {
		modes := markupModes
		if kind == "boardList" {
			modes = boardListModes
		}
		v.str(pointer+"/mode", *o.Mode, oneOf(modes, key("mode.invalid")))
	}
	if o.Content != nil {
		v.str(pointer+"/content", *o.Content, func(s string) string {
			if len(s) > maxContentBytes {
				return key("content.tooLong")
			}
			return ""
		})
	}
	if o.Language != nil {
		code := o.Mode != nil && *o.Mode == "code"
		v.str(pointer+"/language", *o.Language, func(s string) string {
			if !code || !slices.Contains(codeLanguages, s) {
				return key("language.invalid")
			}
			return ""
		})
	}
	if o.Zones != nil {
		v.zones(pointer+"/zones", o.Zones)
	}
	if o.HourCycle != nil {
		v.str(pointer+"/hourCycle", *o.HourCycle, oneOf(hourCycles, key("hourCycle.invalid")))
	}
	if c := o.Countdown; c != nil {
		invalid := key("countdown.invalid")
		v.str(pointer+"/countdown/to", c.To, func(s string) string {
			if !validRFC3339Offset(s) {
				return invalid
			}
			return ""
		})
		v.str(pointer+"/countdown/label", c.Label, func(s string) string {
			if n := utf8.RuneCountInString(s); n < 1 || n > maxWidgetLabelLen {
				return invalid
			}
			return ""
		})
		v.str(pointer+"/countdown/after", c.After, oneOf(afterModes, invalid))
	}
}

// boardListOptions checks a board list's query, tag and limit (board spec v6, T24 §5.5), after the
// widget keys, in OPTION_ORDER. m is the mode, starred when absent: query is valid in search mode
// only ("" included), at most 100 runes without a C0 or C1 control (the gateway's validSearch, with
// no minimum); tag is a tagPattern tag, present iff the mode is tag (absent: reported at /tag); and
// limit is a whole number from 1 to 50. An invalid mode skips the mode rules: query and tag get only
// their own checks.
func (v *validator) boardListOptions(pointer string, o Options) {
	m, modeValid := "starred", true
	if o.Mode != nil {
		m, modeValid = *o.Mode, slices.Contains(boardListModes, *o.Mode)
	}
	if o.Query != nil {
		v.str(pointer+"/query", *o.Query, func(s string) string {
			if !validBoardQuery(s) || (modeValid && m != "search") {
				return optionKey("query")
			}
			return ""
		})
	}
	switch {
	case o.Tag != nil:
		v.str(pointer+"/tag", *o.Tag, func(s string) string {
			if !tagPattern.MatchString(s) || (modeValid && m != "tag") {
				return optionKey("tag")
			}
			return ""
		})
	case modeValid && m == "tag":
		v.add(pointer+"/tag", optionKey("tag"))
	}
	if x := o.Limit; x != nil && (*x != math.Trunc(*x) || *x < minBoardLimit || *x > maxBoardLimit) {
		v.add(pointer+"/limit", optionKey("limit"))
	}
}

// validBoardQuery reports whether s is at most maxBoardQueryRunes runes with no rune in U+0000–001F
// or U+007F–009F (the gateway's validSearch, without its minimum of 1).
func validBoardQuery(s string) bool {
	n := 0
	for _, r := range s {
		if r <= 0x1f || (r >= 0x7f && r <= 0x9f) {
			return false
		}
		n++
	}
	return n <= maxBoardQueryRunes
}

// zones checks a clock's zones: 1 to 12 (reported at the list), then each item's tz (” or a
// well-formed name other than Local, unique) and label (at most 64 runes).
func (v *validator) zones(pointer string, zones []Zone) {
	const invalid, duplicate = "board.options.zones.invalid", "board.options.zones.duplicate"
	if len(zones) < 1 || len(zones) > maxZones {
		v.add(pointer, invalid)
	}
	for i, z := range zones {
		zp := pointer + "/" + strconv.Itoa(i)
		v.str(zp+"/tz", z.TZ, func(s string) string {
			switch {
			case s != "" && (len(s) > maxZoneNameBytes || !tzName.MatchString(s) || s == "Local"):
				return invalid
			case slices.ContainsFunc(zones[:i], func(e Zone) bool { return e.TZ == s }):
				return duplicate
			}
			return ""
		})
		v.str(zp+"/label", z.Label, func(s string) string {
			if utf8.RuneCountInString(s) > maxWidgetLabelLen {
				return invalid
			}
			return ""
		})
	}
}

// validRFC3339Offset reports whether s is an RFC 3339 date-time with an offset (Z or ±hh:mm) that
// names a real time: month 1–12, day 1 to the month's length (29 February in leap years only), hour
// 0–23, minute and second 0–59, offset at most 23:59. The client's isRfc3339Offset is the same.
func validRFC3339Offset(s string) bool {
	m := rfc3339Offset.FindStringSubmatch(s)
	if m == nil {
		return false
	}
	n := func(i int) int {
		if m[i] == "" {
			return 0
		}
		x, _ := strconv.Atoi(m[i]) // two or four digits: the pattern matched
		return x
	}
	year, month, day := n(1), n(2), n(3)
	if month < 1 || month > 12 || day < 1 || day > daysIn(year, month) {
		return false
	}
	return n(4) <= 23 && n(5) <= 59 && n(6) <= 59 && n(9) <= 23 && n(10) <= 59
}

// daysIn is the number of days of month (1–12) in year, Gregorian.
func daysIn(year, month int) int {
	switch month {
	case 2:
		if year%4 == 0 && (year%100 != 0 || year%400 == 0) {
			return 29
		}
		return 28
	case 4, 6, 9, 11:
		return 30
	}
	return 31
}
