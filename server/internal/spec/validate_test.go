package spec

import (
	"encoding/json"
	"errors"
	"fmt"
	"reflect"
	"strings"
	"testing"
)

type fixtureCase struct {
	Name   string          `json:"name"`
	Raw    *string         `json:"raw"`
	Spec   json.RawMessage `json:"spec"`
	Fields []struct {
		Pointer    string `json:"pointer"`
		MessageKey string `json:"message_key"`
	} `json:"fields"`
}

func fieldsOf(t *testing.T, err error) []FieldError {
	t.Helper()
	var ve *ValidationError
	if !errors.As(err, &ve) {
		t.Fatalf("error = %v, want *ValidationError", err)
	}
	if ve.Error() != "invalid board" {
		t.Errorf("Error() = %q, want %q", ve.Error(), "invalid board")
	}
	return ve.Fields
}

func TestValidateCases(t *testing.T) {
	var cases []fixtureCase
	if err := json.Unmarshal(fixture(t, "invalid.json"), &cases); err != nil {
		t.Fatal(err)
	}
	if len(cases) < 30 {
		t.Fatalf("%d cases, want at least 30", len(cases))
	}
	for _, tc := range cases {
		t.Run(tc.Name, func(t *testing.T) {
			raw := []byte(tc.Spec)
			if tc.Raw != nil {
				raw = []byte(*tc.Raw)
			}
			_, err := ParseBoard(raw)
			got := fieldsOf(t, err)
			want := make([]FieldError, 0, len(tc.Fields))
			for _, f := range tc.Fields {
				want = append(want, FieldError{Pointer: f.Pointer, MessageKey: f.MessageKey})
			}
			if !reflect.DeepEqual(got, want) {
				t.Errorf("fields = %v, want %v", got, want)
			}
		})
	}
}

func panelJSON(id string, y int, text string) string {
	q, _ := json.Marshal(text)
	return fmt.Sprintf(`{"id":%q,"title":"t","grid":{"x":0,"y":%d,"w":12,"h":1},"query":{"lang":"promql","text":%s},"vis":{"kind":"auto"}}`, id, y, q)
}

func boardJSON(title string, panels, sections []string) []byte {
	t, _ := json.Marshal(title)
	return []byte(fmt.Sprintf(`{"title":%s,"panels":[%s],"sections":[%s]}`, t, strings.Join(panels, ","), strings.Join(sections, ",")))
}

func TestValidateLimits(t *testing.T) {
	named := func(prefix string, n int) []string {
		var out []string
		for i := range n {
			out = append(out, panelJSON(fmt.Sprintf("%s-%d", prefix, i), i, "up"))
		}
		return out
	}
	panels := func(n int) []string { return named("p", n) }
	sections := func(n int) []string {
		var out []string
		for i := range n {
			out = append(out, fmt.Sprintf(`{"id":"s-%d","title":"s","collapsed":false,"panels":[]}`, i))
		}
		return out
	}
	cases := []struct {
		name string
		raw  []byte
		want string // "" = valid
	}{
		{"200 panels", boardJSON("b", panels(200), nil), ""},
		{"201 panels", boardJSON("b", panels(201), nil), "/panels board.panels.tooMany"},
		{"200 panels across sections", boardJSON("b", panels(100), []string{
			`{"id":"s-1","title":"s","collapsed":false,"panels":[` + strings.Join(named("q", 100), ",") + `]}`}), ""},
		{"201 panels across sections", boardJSON("b", panels(100), []string{
			`{"id":"s-1","title":"s","collapsed":false,"panels":[` + strings.Join(named("q", 101), ",") + `]}`}), "/panels board.panels.tooMany"},
		{"50 sections", boardJSON("b", nil, sections(50)), ""},
		{"51 sections", boardJSON("b", nil, sections(51)), "/sections board.sections.tooMany"},
		{"title 200 runes", boardJSON(strings.Repeat("é", 200), nil, nil), ""},
		{"title 201 runes", boardJSON(strings.Repeat("é", 201), nil, nil), "/title board.title.tooLong"},
		{"text 16384 bytes", boardJSON("b", []string{panelJSON("p-1", 0, strings.Repeat("a", 16384))}, nil), ""},
		{"text 16385 bytes", boardJSON("b", []string{panelJSON("p-1", 0, strings.Repeat("a", 16385))}, nil), "/panels/0/query/text board.query.text.tooLong"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, err := ParseBoard(tc.raw)
			if tc.want == "" {
				if err != nil {
					t.Fatalf("ParseBoard = %v, want ok", err)
				}
				return
			}
			got := fieldsOf(t, err)
			if len(got) != 1 || got[0].Pointer+" "+got[0].MessageKey != tc.want {
				t.Errorf("fields = %v, want [%s]", got, tc.want)
			}
		})
	}
}

func TestValidateTimeForms(t *testing.T) {
	for _, v := range []string{"now", "now/d", "now-5m", "now-99999w", "2026-11-20T10:00Z", "2026-11-20T10:00:05+09:00", "2026-11-20T10:00:05.123Z"} {
		raw := []byte(fmt.Sprintf(`{"title":"b","time":{"from":%q,"to":"now"},"panels":[],"sections":[]}`, v))
		if _, err := ParseBoard(raw); err != nil {
			t.Errorf("time.from %q: %v, want ok", v, err)
		}
	}
	for _, v := range []string{"now-0m", "now-100000s", "now-1y", "2026-11-20", "2026-11-20T10:00:05.12Z", "now+1h"} {
		raw := []byte(fmt.Sprintf(`{"title":"b","time":{"from":%q,"to":"now"},"panels":[],"sections":[]}`, v))
		_, err := ParseBoard(raw)
		if got := fieldsOf(t, err); len(got) != 1 || got[0] != (FieldError{"/time/from", "board.time.invalid"}) {
			t.Errorf("time.from %q: fields %v, want /time/from board.time.invalid", v, got)
		}
	}
}

func TestValidateStopsAt50(t *testing.T) {
	var panels []string
	for i := range 60 {
		panels = append(panels, panelJSON("BAD", i, "up"))
	}
	_, err := ParseBoard(boardJSON("b", panels, nil))
	if got := fieldsOf(t, err); len(got) != 50 {
		t.Errorf("%d fields, want 50", len(got))
	}
}

func TestCheckEnvelope(t *testing.T) {
	spec := `{"title":"b","panels":[],"sections":[]}`
	cases := []struct {
		name string
		e    Envelope
		raw  string
		want []FieldError
	}{
		{"create ok", CreateEnvelope, `{"spec":` + spec + `}`, nil},
		{"create ok with any spec value", CreateEnvelope, `{"spec":"not a board"}`, nil},
		{"update ok", UpdateEnvelope, `{"spec":` + spec + `,"message":"m"}`, nil},
		{"update without message", UpdateEnvelope, `{"spec":` + spec + `}`, nil},
		{"unknown key", CreateEnvelope, `{"spec":` + spec + `,"extra":1}`, []FieldError{{"/extra", keyUnknownKey}}},
		{"message on create", CreateEnvelope, `{"spec":` + spec + `,"message":"m"}`, []FieldError{{"/message", keyUnknownKey}}},
		{"wrong case", CreateEnvelope, `{"Spec":` + spec + `}`, []FieldError{{"/Spec", keyUnknownKey}, {"/spec", keyRequired}}},
		{"duplicate spec", CreateEnvelope, `{"spec":` + spec + `,"spec":` + spec + `}`, []FieldError{{"/spec", keyDuplicateKey}}},
		{"missing spec", UpdateEnvelope, `{"message":"m"}`, []FieldError{{"/spec", keyRequired}}},
		{"message not a string", UpdateEnvelope, `{"spec":` + spec + `,"message":1}`, []FieldError{{"/message", keyType}}},
		{"message null", UpdateEnvelope, `{"spec":` + spec + `,"message":null}`, []FieldError{{"/message", keyNull}}},
		{"trailing value", CreateEnvelope, `{"spec":` + spec + `} {"spec":{}}`, []FieldError{{"", keyInvalid}}},
		{"trailing garbage", CreateEnvelope, `{"spec":` + spec + `}x`, []FieldError{{"", keyInvalid}}},
		{"not an object", CreateEnvelope, `[]`, []FieldError{{"", keyType}}},
		{"empty", CreateEnvelope, ``, []FieldError{{"", keyInvalid}}},
		{"truncated", UpdateEnvelope, `{"spec":{"title":`, []FieldError{{"", keyInvalid}}},
	}
	for _, tc := range cases {
		got := CheckEnvelope([]byte(tc.raw), tc.e)
		if !reflect.DeepEqual(got, tc.want) {
			t.Errorf("%s: %v, want %v", tc.name, got, tc.want)
		}
	}
}

// v2-full's p-1 holds a 1e15 step (steps[2]); each case replaces its text (plan #64 Part B §5).
func TestThresholdValueRange(t *testing.T) {
	raw := string(fixture(t, "v2-full.json"))
	const step = "1000000000000000"
	if strings.Count(raw, step) != 1 {
		t.Fatalf("v2-full.json holds %d copies of %s, want 1", strings.Count(raw, step), step)
	}
	want := []FieldError{{"/panels/0/vis/thresholds/steps/2/value", "board.thresholds.value.range"}}
	cases := []struct {
		value string
		valid bool
	}{
		{"1.7976931348623157e308", false},
		{"-1.7976931348623157e308", false},
		{"1.0000001e15", false},
		{"5e-324", false},
		{"-5e-324", false},
		{"1e-10", false},
		{"-1e-10", false},
		{"1000000000000000", true},
		{"1e-9", true},
		{"-1e-9", true},
		{"0", true},
	}
	for _, tc := range cases {
		t.Run(tc.value, func(t *testing.T) {
			_, err := ParseBoard([]byte(strings.Replace(raw, step, tc.value, 1)))
			if tc.valid {
				if err != nil {
					t.Fatalf("ParseBoard = %v, want ok", err)
				}
				return
			}
			if got := fieldsOf(t, err); !reflect.DeepEqual(got, want) {
				t.Errorf("fields = %v, want %v", got, want)
			}
		})
	}
}

func TestNumberShape(t *testing.T) {
	spec := func(value string) []byte {
		return []byte(`{"title":"B","panels":[{"id":"p-1","title":"A","grid":{"x":0,"y":0,"w":6,"h":8},` +
			`"query":{"lang":"promql","text":"up"},"vis":{"kind":"line","thresholds":{"direction":"above",` +
			`"steps":[{"value":` + value + `,"state":"watch","label":""}]}}}],"sections":[]}`)
	}
	for _, tc := range []struct {
		value string
		ok    bool
	}{{"1.5", true}, {"-0", true}, {"1e3", true}, {`"1"`, false}, {"true", false}, {"1e400", false}} {
		_, err := ParseBoard(spec(tc.value))
		if tc.ok {
			if err != nil {
				t.Errorf("value %s: %v, want ok", tc.value, err)
			}
			continue
		}
		want := []FieldError{{"/panels/0/vis/thresholds/steps/0/value", keyType}}
		if got := fieldsOf(t, err); !reflect.DeepEqual(got, want) {
			t.Errorf("value %s: fields %v, want %v", tc.value, got, want)
		}
	}
}
