package spec

import (
	"archive/zip"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

// fixtureCase is one row of invalid.json; ClientFields, when present, are what the client's suite
// expects instead of Fields (zone existence is the server's only).
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
			_, err := ParseNewBoard(raw)
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

// widgetBoard is a board of one widget panel p-1 with vis (JSON).
func widgetBoard(vis string) []byte {
	return []byte(`{"title":"B","panels":[{"id":"p-1","title":"A","grid":{"x":0,"y":0,"w":6,"h":8},"vis":` + vis + `}],"sections":[]}`)
}

// clockVis is a clock's vis with the zones given as JSON items.
func clockVis(zones ...string) string {
	return `{"kind":"clock","options":{"zones":[` + strings.Join(zones, ",") + `]}}`
}

func zoneJSON(tz, label string) string {
	b, _ := json.Marshal(map[string]string{"tz": tz, "label": label})
	return string(b)
}

const opts = "/panels/0/vis/options"

// TestWidgetLimits: the bounds of content, zones, zone labels and countdown labels (T24-003).
func TestWidgetLimits(t *testing.T) {
	text := func(content string) []byte {
		c, _ := json.Marshal(content)
		return widgetBoard(`{"kind":"text","options":{"content":` + string(c) + `}}`)
	}
	zones := func(n int) []byte {
		items := make([]string, n)
		for i := range items {
			items[i] = zoneJSON(fmt.Sprintf("Etc/GMT+%d", i), "")
		}
		items[0] = zoneJSON("UTC", "")
		return widgetBoard(clockVis(items...))
	}
	countdown := func(label string) []byte {
		l, _ := json.Marshal(label)
		return widgetBoard(`{"kind":"clock","options":{"countdown":{"to":"2026-11-26T14:00:00Z","label":` + string(l) + `,"after":"hide"}}}`)
	}
	content := strings.Repeat("€", 21845) + "a"
	if len(content) != 65536 {
		t.Fatalf("content is %d bytes, want 65536", len(content))
	}
	cases := []struct {
		name string
		raw  []byte
		want string // "" = valid
	}{
		{"content 65536 bytes", text(content), ""},
		{"content 65537 bytes", text(content + "a"), opts + "/content board.options.content.tooLong"},
		{"12 zones", zones(12), ""},
		{"13 zones", zones(13), opts + "/zones board.options.zones.invalid"},
		{"zone label 64 runes", widgetBoard(clockVis(zoneJSON("UTC", strings.Repeat("é", 64)))), ""},
		{"zone label 65 runes", widgetBoard(clockVis(zoneJSON("UTC", strings.Repeat("é", 65)))), opts + "/zones/0/label board.options.zones.invalid"},
		{"countdown label empty", countdown(""), opts + "/countdown/label board.options.countdown.invalid"},
		{"countdown label 64 runes", countdown(strings.Repeat("é", 64)), ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, err := ParseNewBoard(tc.raw)
			if tc.want == "" {
				if err != nil {
					t.Fatalf("ParseNewBoard = %v, want ok", err)
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

// TestZoneNames: the tz format on every parse, and existence in the build's zone set on new specs.
func TestZoneNames(t *testing.T) {
	for _, tz := range []string{"", "UTC", "Europe/London", "America/Argentina/Buenos_Aires", "Etc/GMT+5", "EST5EDT"} {
		if _, err := ParseNewBoard(widgetBoard(clockVis(zoneJSON(tz, "")))); err != nil {
			t.Errorf("tz %q: %v, want ok", tz, err)
		}
	}
	want := []FieldError{{opts + "/zones/0/tz", "board.options.zones.invalid"}}
	for _, tz := range []string{"Local", "Mars/Base", "../etc/passwd", "/etc/localtime", "Europe/London ", strings.Repeat("a", 65)} {
		_, err := ParseNewBoard(widgetBoard(clockVis(zoneJSON(tz, ""))))
		if err == nil {
			t.Errorf("tz %q: ok, want zones.invalid", tz)
			continue
		}
		if got := fieldsOf(t, err); !reflect.DeepEqual(got, want) {
			t.Errorf("tz %q: fields %v, want %v", tz, got, want)
		}
	}
	// A stored zone is always readable: ParseBoard checks the format only.
	if _, err := ParseBoard(widgetBoard(clockVis(zoneJSON("Mars/Base", "")))); err != nil {
		t.Errorf("ParseBoard(Mars/Base) = %v, want ok", err)
	}
}

// TestCheckZones: existence is asked once per distinct name, never for ”, and a name in keep is
// not asked at all.
func TestCheckZones(t *testing.T) {
	calls := map[string]int{}
	saved := zoneExists
	t.Cleanup(func() { zoneExists = saved })
	zoneExists = func(tz string) bool {
		calls[tz]++
		return tz == "Fresh/Zone"
	}
	panel := func(i int, tz string) string {
		return fmt.Sprintf(`{"id":"p-%d","title":"A","grid":{"x":0,"y":%d,"w":6,"h":1},"vis":%s}`, i, i, clockVis(zoneJSON(tz, "")))
	}
	raw := []byte(`{"title":"B","panels":[` + strings.Join([]string{panel(0, "Fresh/Zone"), panel(1, "Fresh/Zone"), panel(2, "Gone/Zone"), panel(3, "")}, ",") + `],"sections":[]}`)
	b, err := ParseBoard(raw)
	if err != nil {
		t.Fatalf("ParseBoard: %v", err)
	}
	err = b.CheckZones(nil)
	if err == nil {
		t.Fatal("CheckZones(nil) = nil, want Gone/Zone refused")
	}
	if got, want := fieldsOf(t, err), []FieldError{{"/panels/2/vis/options/zones/0/tz", "board.options.zones.invalid"}}; !reflect.DeepEqual(got, want) {
		t.Errorf("CheckZones(nil) = %v, want %v", got, want)
	}
	if want := map[string]int{"Fresh/Zone": 1, "Gone/Zone": 1}; !reflect.DeepEqual(calls, want) {
		t.Errorf("zoneExists calls = %v, want %v", calls, want)
	}
	if err := b.CheckZones(map[string]bool{"Gone/Zone": true}); err != nil {
		t.Errorf("CheckZones({Gone/Zone}) = %v, want nil", err)
	}
}

// TestZonesIgnoreHost: ZONEINFO (the host's zone database) is never read.
func TestZonesIgnoreHost(t *testing.T) {
	path := filepath.Join(t.TempDir(), "zoneinfo.zip")
	f, err := os.Create(path) //nolint:gosec // the test's own temporary file
	if err != nil {
		t.Fatal(err)
	}
	zw := zip.NewWriter(f)
	w, err := zw.CreateHeader(&zip.FileHeader{Name: "Host/Only", Method: zip.Store})
	if err != nil {
		t.Fatal(err)
	}
	// A minimal TZif file: UTC, no transitions.
	if _, err := w.Write(tzifUTC()); err != nil {
		t.Fatal(err)
	}
	if err := zw.Close(); err != nil {
		t.Fatal(err)
	}
	if err := f.Close(); err != nil {
		t.Fatal(err)
	}
	t.Setenv("ZONEINFO", path)
	if _, err := ParseNewBoard(widgetBoard(clockVis(zoneJSON("Host/Only", "")))); err == nil {
		t.Error("ParseNewBoard(Host/Only) = ok, want zones.invalid")
	}
	if _, err := ParseNewBoard(widgetBoard(clockVis(zoneJSON("Europe/London", "")))); err != nil {
		t.Errorf("ParseNewBoard(Europe/London) = %v, want ok", err)
	}
}

// tzifUTC is a version 1 TZif file with one type, UTC (RFC 8536).
func tzifUTC() []byte {
	b := []byte("TZif\x00")
	b = append(b, make([]byte, 15)...)
	// isutcnt, isstdcnt, leapcnt, timecnt, typecnt, charcnt
	for _, n := range []byte{0, 0, 0, 0, 1, 4} {
		b = append(b, 0, 0, 0, n)
	}
	b = append(b, 0, 0, 0, 0, 0, 0) // utoff 0, isdst 0, desigidx 0
	return append(b, 'U', 'T', 'C', 0)
}

// TestRFC3339Offset: countdown.to is RFC 3339 with an offset and a real date (T24-003).
func TestRFC3339Offset(t *testing.T) {
	for _, s := range []string{"2026-11-26T14:00:00Z", "2026-11-26T14:00:00+09:00", "2026-11-26T14:00:00.123456789-05:30", "2024-02-29T00:00:00Z"} {
		if !validRFC3339Offset(s) {
			t.Errorf("validRFC3339Offset(%q) = false, want true", s)
		}
	}
	for _, s := range []string{"2026-11-26 14:00", "2026-11-26T14:00:00", "2026-02-29T00:00:00Z", "2026-11-26T24:00:00Z", "2026-11-26T14:00:60Z", "2026-11-26T14:00:00+24:00", "2026-11-26T14:00:00z"} {
		if validRFC3339Offset(s) {
			t.Errorf("validRFC3339Offset(%q) = true, want false", s)
		}
	}
}

// TestBoardListBounds: the board list's query length (runes), its Cc rule and U+0000 first, and
// the limit bounds, written as an integer or with an exponent (T24-021, T24 §5.5).
func TestBoardListBounds(t *testing.T) {
	list := func(options string) []byte { return widgetBoard(`{"kind":"boardList","options":` + options + `}`) }
	search := func(q string) []byte {
		b, _ := json.Marshal(q)
		return list(`{"mode":"search","query":` + string(b) + `}`)
	}
	cases := []struct {
		name string
		raw  []byte
		want string // "" = valid
	}{
		{"query 100 runes", search(strings.Repeat("é", 100)), ""},
		{"limit 1", list(`{"limit":1}`), ""},
		{"limit 50", list(`{"limit":50}`), ""},
		{"limit 1e1", list(`{"limit":1e1}`), ""},
		{"query U+0085", search("a\u0085b"), opts + "/query board.options.query.invalid"},
		{"query U+0000", search("a\u0000"), opts + "/query board.string.nul"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, err := ParseNewBoard(tc.raw)
			if tc.want == "" {
				if err != nil {
					t.Fatalf("ParseNewBoard = %v, want ok", err)
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
