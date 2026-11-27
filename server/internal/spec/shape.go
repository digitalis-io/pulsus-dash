package spec

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"slices"
	"strconv"
	"strings"
)

// Message keys of the shape pass (plan #61 §3.4.1).
const (
	keyInvalid      = "board.json.invalid"
	keyDuplicateKey = "board.json.duplicateKey"
	keyUnknownKey   = "board.json.unknownKey"
	keyRequired     = "board.json.required"
	keyNull         = "board.json.null"
	keyType         = "board.json.type"
)

type kind int

const (
	kString kind = iota
	kBool
	kInt    // a JSON number with no '.', 'e' or 'E' that fits int32
	kNumber // any JSON number that is a finite float64 (not 1e400)
	kArray
	kObject
	kAny // any JSON value, checked later (the spec inside a request envelope)
	// kRawObject is a JSON object kept raw and checked when the enclosing object closes, against
	// the shape its sibling "kind" names (vis.options, board spec v3: options may come before kind).
	kRawObject
)

// valueType is the expected type of a value: an object of a shape, or an array of elem; JSON null
// is accepted when nullable (board spec v7: the geomap's groupBy and view).
type valueType struct {
	kind     kind
	shape    []field
	elem     *valueType
	nullable bool
}

// field is one key of an object shape, in table order.
type field struct {
	name     string
	required bool
	t        valueType
}

var (
	tString = valueType{kind: kString}
	tBool   = valueType{kind: kBool}
	tInt    = valueType{kind: kInt}
	tNumber = valueType{kind: kNumber}

	gridShape  = []field{{"x", true, tInt}, {"y", true, tInt}, {"w", true, tInt}, {"h", true, tInt}}
	queryShape = []field{{"lang", true, tString}, {"text", true, tString}}
	// Board spec v2 (#64 Part B §3.1): thresholds and legend are optional members of vis.
	stepShape       = []field{{"value", true, tNumber}, {"state", true, tString}, {"label", true, tString}}
	thresholdsShape = []field{{"direction", true, tString},
		{"steps", true, valueType{kind: kArray, elem: &valueType{kind: kObject, shape: stepShape}}}}
	legendShape = []field{{"mode", true, tString}}
	// Board spec v8 (#290, T22 §6.2): the unit, an id and an optional suffix.
	unitShape = []field{{"id", true, tString}, {"suffix", false, tString}}
	// Board spec v3 (#173 Part 1, T22 §6.1): options, checked against the kind's shape.
	visShape = []field{{"kind", true, tString},
		{"thresholds", false, valueType{kind: kObject, shape: thresholdsShape}},
		{"legend", false, valueType{kind: kObject, shape: legendShape}},
		{"unit", false, valueType{kind: kObject, shape: unitShape}},
		{"options", false, valueType{kind: kRawObject}}}

	// optionFields are the keys of vis.options in OPTION_ORDER (client boards/options.ts), all
	// optional; optionKinds lists the keys each kind allows. Both equal
	// api/fixtures/board-spec/option-keys.json. Board spec v5 (#198 Part 1, T24 §5.1) adds the text
	// and clock keys: zones is an array of {tz, label}, countdown an object {to, label, after}, every
	// member a required string (OPTION_MEMBERS). Board spec v6 (#216 Part 1, T24 §5.5) adds the
	// board list's query, tag and limit (a number here; the rules pass requires an integer). Board
	// spec v7 (#234 Part 1, T24 §5.15) adds the geomap's keys; groupBy and view may be null.
	optionFields = []field{{"reducer", false, tString}, {"baselineOffset", false, tString},
		{"categoryBy", false, tString}, {"sort", false, tString}, {"orientation", false, tString},
		{"valueLabels", false, tBool}, {"min", false, tNumber}, {"max", false, tNumber},
		{"donut", false, tBool}, {"labels", false, tString}, {"parts", false, tBool},
		{"layout", false, tString}, {"colourMode", false, tString}, {"textMode", false, tString},
		{"graphMode", false, tString},
		{"mode", false, tString}, {"content", false, tString}, {"language", false, tString},
		{"zones", false, valueType{kind: kArray, elem: &valueType{kind: kObject, shape: zoneShape}}},
		{"hourCycle", false, tString}, {"seconds", false, tBool}, {"date", false, tBool},
		{"countdown", false, valueType{kind: kObject, shape: countdownShape}},
		{"query", false, tString}, {"tag", false, tString}, {"limit", false, tNumber},
		{"location", false, valueType{kind: kObject, shape: locationShape}},
		{"size", false, valueType{kind: kObject, shape: sizeShape}},
		{"colour", false, tString}, {"groupBy", false, valueType{kind: kString, nullable: true}},
		{"symbol", false, tString}, {"cluster", false, tBool}, {"wheelZoom", false, tBool},
		{"view", false, valueType{kind: kObject, shape: viewShape, nullable: true}}}
	// The geomap's object keys (board spec v7, T24 §5.15; the client's OPTION_OBJECT_MEMBERS):
	// typed members, required or optional; which members a location mode allows is the rules pass's.
	locationShape = []field{{"mode", true, tString}, {"lat", false, tString}, {"lon", false, tString},
		{"field", false, tString}, {"gazetteer", false, tString}, {"country", false, tString}}
	sizeShape      = []field{{"by", false, tString}, {"min", false, tNumber}, {"max", false, tNumber}}
	viewShape      = []field{{"lat", true, tNumber}, {"lon", true, tNumber}, {"zoom", true, tNumber}}
	zoneShape      = []field{{"tz", true, tString}, {"label", true, tString}}
	countdownShape = []field{{"to", true, tString}, {"label", true, tString}, {"after", true, tString}}
	optionKinds    = map[string][]string{
		"auto":      {"reducer", "parts"},
		"line":      {},
		"bars":      {},
		"heatmap":   {},
		"stat":      {"reducer", "baselineOffset", "sort", "orientation", "min", "max", "layout", "colourMode", "textMode", "graphMode"},
		"logs":      {},
		"barchart":  {"reducer", "baselineOffset", "categoryBy", "sort", "orientation", "valueLabels", "min", "max"},
		"pie":       {"reducer", "categoryBy", "sort", "donut", "labels", "parts"},
		"text":      {"mode", "content", "language"},
		"clock":     {"zones", "hourCycle", "seconds", "date", "countdown"},
		"boardList": {"sort", "mode", "query", "tag", "limit"},
		"geomap":    {"reducer", "labels", "location", "size", "colour", "groupBy", "symbol", "cluster", "wheelZoom", "view"},
	}
	panelShape = []field{{"id", true, tString}, {"title", true, tString},
		{"grid", true, valueType{kind: kObject, shape: gridShape}},
		// Optional from board spec v5 (#198 Part 1): the rules pass requires it on a data panel and
		// refuses it on a widget (validate.go).
		{"query", false, valueType{kind: kObject, shape: queryShape}},
		{"vis", true, valueType{kind: kObject, shape: visShape}}}
	tPanels      = valueType{kind: kArray, elem: &valueType{kind: kObject, shape: panelShape}}
	sectionShape = []field{{"id", true, tString}, {"title", true, tString}, {"collapsed", true, tBool}, {"panels", true, tPanels}}
	timeShape    = []field{{"from", true, tString}, {"to", true, tString}}
	boardShape   = []field{{"title", true, tString}, {"panels", true, tPanels},
		{"sections", true, valueType{kind: kArray, elem: &valueType{kind: kObject, shape: sectionShape}}},
		{"time", false, valueType{kind: kObject, shape: timeShape}},
		// Board spec v4 (#215, T24-029): tags.
		{"tags", false, valueType{kind: kArray, elem: &tString}}}
	tBoard = valueType{kind: kObject, shape: boardShape}

	// The request envelopes of POST /boards (BoardCreate) and PUT /boards/{uid} (BoardUpdate).
	tCreate = valueType{kind: kObject, shape: []field{{"spec", true, valueType{kind: kAny}}}}
	tUpdate = valueType{kind: kObject, shape: []field{{"spec", true, valueType{kind: kAny}}, {"message", false, tString}}}
)

// errSyntax aborts the shape pass: raw is not one JSON value.
var errSyntax = errors.New("not JSON")

// shapeChecker walks the tokens of a document against the shape table.
type shapeChecker struct {
	dec    *json.Decoder
	fields []FieldError
}

func (c *shapeChecker) add(pointer, key string) {
	if len(c.fields) < maxFieldErrors {
		c.fields = append(c.fields, FieldError{Pointer: pointer, MessageKey: key})
	}
}

// checkShape returns the shape problems of raw in document order (nil when the shape is clean).
// A document that is not exactly one JSON value reports only board.json.invalid.
func checkShape(raw []byte) []FieldError { return checkValue(raw, tBoard) }

// Envelope is the request body around a board spec.
type Envelope int

const (
	// CreateEnvelope is {"spec": …}.
	CreateEnvelope Envelope = iota
	// UpdateEnvelope is {"spec": …, "message": "…"} with message optional.
	UpdateEnvelope
)

// CheckEnvelope checks a whole request body with the shape rules of the spec: exactly one JSON
// object, exact keys, no duplicate, required spec, a string message, no trailing data. The spec's
// own value is not inspected here; ParseBoard checks it, with pointers relative to the spec.
// Pointers of envelope problems are relative to the body (/spec, /message, /<unknown key>).
func CheckEnvelope(raw []byte, e Envelope) []FieldError {
	if e == UpdateEnvelope {
		return checkValue(raw, tUpdate)
	}
	return checkValue(raw, tCreate)
}

func checkValue(raw []byte, t valueType) []FieldError {
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	c := &shapeChecker{dec: dec}
	if err := c.value("", t); err != nil {
		return []FieldError{{Pointer: "", MessageKey: keyInvalid}}
	}
	if _, err := dec.Token(); err != io.EOF {
		return []FieldError{{Pointer: "", MessageKey: keyInvalid}}
	}
	return c.fields
}

func (c *shapeChecker) token() (json.Token, error) {
	tok, err := c.dec.Token()
	if err != nil {
		return nil, errSyntax
	}
	return tok, nil
}

// optionShape is the shape of a kind's vis.options (§3.3 of plan #173 Part 1): the kind's keys,
// optional and typed, in OPTION_ORDER. A kind without options allows no key ({} is valid).
func optionShape(kind string) []field {
	allowed := optionKinds[kind]
	shape := make([]field, 0, len(allowed))
	for _, f := range optionFields {
		if slices.Contains(allowed, f.name) {
			shape = append(shape, f)
		}
	}
	return shape
}

// value reads one value at pointer and checks it against t.
func (c *shapeChecker) value(pointer string, t valueType) error {
	if t.kind == kAny {
		return c.skip()
	}
	tok, err := c.token()
	if err != nil {
		return err
	}
	return c.check(pointer, tok, t)
}

// check checks one value whose first token tok was read.
func (c *shapeChecker) check(pointer string, tok json.Token, t valueType) error {
	if tok == nil {
		if !t.nullable {
			c.add(pointer, keyNull)
		}
		return nil
	}
	switch v := tok.(type) {
	case json.Delim:
		switch {
		case v == '{' && t.kind == kObject:
			return c.object(pointer, t.shape)
		case v == '[' && t.kind == kArray:
			for i := 0; c.dec.More(); i++ {
				if err := c.value(pointer+"/"+strconv.Itoa(i), *t.elem); err != nil {
					return err
				}
			}
			_, err := c.token() // ']'
			return err
		}
		c.add(pointer, keyType)
		return c.skipRest()
	case string:
		if t.kind != kString {
			c.add(pointer, keyType)
		}
	case bool:
		if t.kind != kBool {
			c.add(pointer, keyType)
		}
	case json.Number:
		switch t.kind {
		case kInt:
			if !isInt32(string(v)) {
				c.add(pointer, keyType)
			}
		case kNumber:
			// Float64 fails only out of range (1e400): not a finite number.
			if _, err := v.Float64(); err != nil {
				c.add(pointer, keyType)
			}
		default:
			c.add(pointer, keyType)
		}
	}
	return nil
}

func isInt32(s string) bool {
	if strings.ContainsAny(s, ".eE") {
		return false
	}
	_, err := strconv.ParseInt(s, 10, 32)
	return err == nil
}

// rawObject reads a kRawObject value: an object is returned raw; null and other types are
// reported in place, and nil is returned.
func (c *shapeChecker) rawObject(pointer string) (json.RawMessage, error) {
	var raw json.RawMessage
	if err := c.dec.Decode(&raw); err != nil {
		return nil, errSyntax
	}
	raw = bytes.TrimSpace(raw)
	switch {
	case bytes.Equal(raw, []byte("null")):
		c.add(pointer, keyNull)
	case len(raw) > 0 && raw[0] == '{':
		return raw, nil
	default:
		c.add(pointer, keyType)
	}
	return nil, nil
}

// checkRawAt checks a raw value (one JSON value, read by rawObject) against t, with pointers under
// pointer; its problems are appended to c's.
func (c *shapeChecker) checkRawAt(raw json.RawMessage, pointer string, t valueType) error {
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	sub := &shapeChecker{dec: dec, fields: c.fields}
	err := sub.value(pointer, t)
	c.fields = sub.fields
	return err
}

// object reads the members of an object after its '{'. A kRawObject member (vis.options) is kept
// raw and checked after the object's own problems, against optionShape of the sibling "kind",
// only when that kind is a string in visKinds; any other kind is reported by the rules pass.
func (c *shapeChecker) object(pointer string, shape []field) error {
	seen := make(map[string]bool, len(shape))
	var (
		tag        string
		tagged     bool
		deferred   json.RawMessage
		deferredAt string
	)
	for c.dec.More() {
		tok, err := c.token()
		if err != nil {
			return err
		}
		key, _ := tok.(string)
		p := pointer + "/" + escapePointer(key)
		f, known := lookup(shape, key)
		switch {
		case seen[key]:
			c.add(p, keyDuplicateKey)
			err = c.skip()
		case !known:
			c.add(p, keyUnknownKey)
			err = c.skip()
		case f.t.kind == kRawObject:
			deferred, err = c.rawObject(p)
			deferredAt = p
		case key == "kind" && f.t.kind == kString:
			var tok json.Token
			if tok, err = c.token(); err == nil {
				tag, tagged = tok.(string)
				err = c.check(p, tok, f.t)
			}
		default:
			err = c.value(p, f.t)
		}
		if err != nil {
			return err
		}
		seen[key] = true
	}
	if _, err := c.token(); err != nil { // '}'
		return err
	}
	for _, f := range shape {
		if f.required && !seen[f.name] {
			c.add(pointer+"/"+escapePointer(f.name), keyRequired)
		}
	}
	if deferred != nil && tagged && slices.Contains(visKinds, tag) {
		return c.checkRawAt(deferred, deferredAt, valueType{kind: kObject, shape: optionShape(tag)})
	}
	return nil
}

func lookup(shape []field, key string) (field, bool) {
	for _, f := range shape {
		if f.name == key {
			return f, true
		}
	}
	return field{}, false
}

// skip reads one value of any type.
func (c *shapeChecker) skip() error {
	tok, err := c.token()
	if err != nil {
		return err
	}
	if d, ok := tok.(json.Delim); ok && (d == '{' || d == '[') {
		return c.skipRest()
	}
	return nil
}

// skipRest reads the rest of an object or array whose opening delimiter was read.
func (c *shapeChecker) skipRest() error {
	for depth := 1; depth > 0; {
		tok, err := c.token()
		if err != nil {
			return err
		}
		if d, ok := tok.(json.Delim); ok {
			if d == '{' || d == '[' {
				depth++
			} else {
				depth--
			}
		}
	}
	return nil
}

// escapePointer escapes a key for a JSON pointer (RFC 6901): ~ → ~0, / → ~1.
func escapePointer(key string) string {
	return strings.ReplaceAll(strings.ReplaceAll(key, "~", "~0"), "/", "~1")
}
