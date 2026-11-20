package spec

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
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
	kInt // a JSON number with no '.', 'e' or 'E' that fits int32
	kArray
	kObject
	kAny // any JSON value, checked later (the spec inside a request envelope)
)

// valueType is the expected type of a value: an object of a shape, or an array of elem.
type valueType struct {
	kind  kind
	shape []field
	elem  *valueType
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

	gridShape  = []field{{"x", true, tInt}, {"y", true, tInt}, {"w", true, tInt}, {"h", true, tInt}}
	queryShape = []field{{"lang", true, tString}, {"text", true, tString}}
	visShape   = []field{{"kind", true, tString}}
	panelShape = []field{{"id", true, tString}, {"title", true, tString},
		{"grid", true, valueType{kind: kObject, shape: gridShape}},
		{"query", true, valueType{kind: kObject, shape: queryShape}},
		{"vis", true, valueType{kind: kObject, shape: visShape}}}
	tPanels      = valueType{kind: kArray, elem: &valueType{kind: kObject, shape: panelShape}}
	sectionShape = []field{{"id", true, tString}, {"title", true, tString}, {"collapsed", true, tBool}, {"panels", true, tPanels}}
	timeShape    = []field{{"from", true, tString}, {"to", true, tString}}
	boardShape   = []field{{"title", true, tString}, {"panels", true, tPanels},
		{"sections", true, valueType{kind: kArray, elem: &valueType{kind: kObject, shape: sectionShape}}},
		{"time", false, valueType{kind: kObject, shape: timeShape}}}
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

// value reads one value at pointer and checks it against t.
func (c *shapeChecker) value(pointer string, t valueType) error {
	if t.kind == kAny {
		return c.skip()
	}
	tok, err := c.token()
	if err != nil {
		return err
	}
	if tok == nil {
		c.add(pointer, keyNull)
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
		if t.kind != kInt || !isInt32(string(v)) {
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

// object reads the members of an object after its '{'.
func (c *shapeChecker) object(pointer string, shape []field) error {
	seen := make(map[string]bool, len(shape))
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
