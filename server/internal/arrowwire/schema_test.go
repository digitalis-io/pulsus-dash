package arrowwire

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"testing"

	"github.com/apache/arrow-go/v18/arrow"
	"go.yaml.in/yaml/v3"

	"github.com/digitalis-io/pulsus-dash/server/internal/pulsusdb"
)

type yamlField struct {
	Name     string `yaml:"name"`
	Type     string `yaml:"type"`
	Nullable bool   `yaml:"nullable"`
}

type yamlMeta struct {
	Required bool     `yaml:"required"`
	Format   string   `yaml:"format"`
	Min      *int64   `yaml:"min"`
	Max      *int64   `yaml:"max"`
	Values   []string `yaml:"values"`
}

type yamlSchema struct {
	Schema   string              `yaml:"schema"`
	Fields   []yamlField         `yaml:"fields"`
	Metadata map[string]yamlMeta `yaml:"metadata"`
}

var fslRe = regexp.MustCompile(`^fixed_size_list<(\w+)(\??)>\[([\w.]+)\]$`)

// yamlType maps a wire/schemas type to arrow-go; lens gives the length of a fixed_size_list key.
func yamlType(s string, lens map[string]int32) (arrow.DataType, error) {
	switch s {
	case "uint8":
		return arrow.PrimitiveTypes.Uint8, nil
	case "uint16":
		return arrow.PrimitiveTypes.Uint16, nil
	case "uint32":
		return arrow.PrimitiveTypes.Uint32, nil
	case "uint64":
		return arrow.PrimitiveTypes.Uint64, nil
	case "float64":
		return arrow.PrimitiveTypes.Float64, nil
	case "bool":
		return arrow.FixedWidthTypes.Boolean, nil
	case "utf8":
		return arrow.BinaryTypes.String, nil
	case "timestamp_ms":
		return &arrow.TimestampType{Unit: arrow.Millisecond, TimeZone: "UTC"}, nil
	case "list<utf8>":
		return arrow.ListOfNonNullable(arrow.BinaryTypes.String), nil
	}
	if m := fslRe.FindStringSubmatch(s); m != nil {
		child, err := yamlType(m[1], lens)
		if err != nil {
			return nil, err
		}
		n, ok := lens[m[3]]
		if !ok {
			return nil, fmt.Errorf("no length for %s", m[3])
		}
		return arrow.FixedSizeListOfField(n, arrow.Field{Name: "item", Type: child, Nullable: m[2] == "?"}), nil
	}
	return nil, fmt.Errorf("unknown type %q", s)
}

func hasDictionary(t arrow.DataType) bool {
	switch dt := t.(type) {
	case *arrow.DictionaryType:
		return true
	case arrow.NestedType:
		for _, f := range dt.Fields() {
			if hasDictionary(f.Type) {
				return true
			}
		}
	}
	return false
}

func checkFormat(t *testing.T, key, format, v string, m yamlMeta) {
	t.Helper()
	switch {
	case strings.HasPrefix(format, "const:"):
		if v != strings.TrimPrefix(format, "const:") {
			t.Errorf("%s = %q, want %s", key, v, format)
		}
	case format == "i64" || format == "u32":
		bits := 64
		if format == "u32" {
			bits = 32
		}
		var n int64
		var err error
		if format == "u32" {
			var u uint64
			u, err = strconv.ParseUint(v, 10, bits)
			n = int64(u)
		} else {
			n, err = strconv.ParseInt(v, 10, bits)
		}
		if err != nil {
			t.Errorf("%s = %q is not %s", key, v, format)
		}
		if m.Min != nil && n < *m.Min || m.Max != nil && n > *m.Max {
			t.Errorf("%s = %d outside [%v, %v]", key, n, m.Min, m.Max)
		}
	case format == "json":
		if !json.Valid([]byte(v)) {
			t.Errorf("%s is not JSON", key)
		}
	case format == "text":
		if len(m.Values) > 0 && !contains(m.Values, v) {
			t.Errorf("%s = %q not in %v", key, v, m.Values)
		}
	default:
		t.Errorf("%s: unknown format %q", key, format)
	}
}

func contains(xs []string, x string) bool {
	for _, s := range xs {
		if s == x {
			return true
		}
	}
	return false
}

func metaKeys(s *arrow.Schema) []string {
	ks := append([]string(nil), s.Metadata().Keys()...)
	sort.Strings(ks)
	return ks
}

// unit:schema-yaml (ADR-0015, T04-003): wire/schemas/*.yaml are the writer's four schemas.
func TestSchemaYAML(t *testing.T) {
	files, err := filepath.Glob("../../../wire/schemas/*.yaml")
	if err != nil {
		t.Fatal(err)
	}
	full := GridSpec{LabelsPart: 1, DataPart: 2, Grid: pulsusdb.Grid{Start: 0, End: 45_000, Step: 15_000}, Result: "metric",
		Source: "pulsusdb", Unit: "bytes", RequestedStartMs: 7, Planned: []byte(`{"query":"up"}`)}
	minimal := full
	minimal.Unit, minimal.Planned = "", nil
	writer := map[string][2]*arrow.Schema{
		"labels/1":             {labelsSchema(), labelsSchema()},
		"metric_matrix.grid/1": {gridSchema(full, 4), gridSchema(minimal, 4)},
		"coverage/1":           {coverageSchema(), coverageSchema()},
		"error/1":              {errorSchema(), errorSchema()},
	}
	if len(files) != len(writer) {
		t.Fatalf("%d schema files, want %d", len(files), len(writer))
	}
	for _, f := range files {
		raw, err := os.ReadFile(f)
		if err != nil {
			t.Fatal(err)
		}
		var y yamlSchema
		if err := yaml.Unmarshal(raw, &y); err != nil {
			t.Fatalf("%s: %v", f, err)
		}
		ws, ok := writer[y.Schema]
		if !ok {
			t.Errorf("%s: schema %q is not written by arrowwire", f, y.Schema)
			continue
		}
		if want := strings.TrimSuffix(y.Schema, "/1") + ".yaml"; filepath.Base(f) != want {
			t.Errorf("%s: file name, want %s", f, want)
		}
		s, sMin := ws[0], ws[1]
		if s.NumFields() != len(y.Fields) {
			t.Errorf("%s: writer has %d fields, YAML %d", y.Schema, s.NumFields(), len(y.Fields))
			continue
		}
		for i, yf := range y.Fields {
			wf := s.Field(i)
			typ, err := yamlType(yf.Type, map[string]int32{"dash.grid.len": 4})
			if err != nil {
				t.Errorf("%s.%s: %v", y.Schema, yf.Name, err)
				continue
			}
			if wf.Name != yf.Name || wf.Nullable != yf.Nullable || !arrow.TypeEqual(wf.Type, typ) {
				t.Errorf("%s field %d: writer %s %s nullable=%v, YAML %s %s nullable=%v", y.Schema, i, wf.Name, wf.Type, wf.Nullable, yf.Name, typ, yf.Nullable)
			}
			if hasDictionary(wf.Type) {
				t.Errorf("%s.%s is dictionary-encoded (T04-003: none in v1)", y.Schema, wf.Name)
			}
		}
		var all, required []string
		for k, m := range y.Metadata {
			all = append(all, k)
			if m.Required {
				required = append(required, k)
			}
		}
		sort.Strings(all)
		sort.Strings(required)
		if got := metaKeys(s); strings.Join(got, ",") != strings.Join(all, ",") {
			t.Errorf("%s: writer metadata %v, YAML %v", y.Schema, got, all)
		}
		if got := metaKeys(sMin); strings.Join(got, ",") != strings.Join(required, ",") {
			t.Errorf("%s: writer's required metadata %v, YAML %v", y.Schema, got, required)
		}
		for i, k := range s.Metadata().Keys() {
			if m, ok := y.Metadata[k]; ok {
				checkFormat(t, k, m.Format, s.Metadata().Values()[i], m)
			}
		}
		if y.Schema == "metric_matrix.grid/1" {
			if m := y.Metadata["dash.grid.len"]; m.Max == nil || *m.Max != MaxGridLen {
				t.Errorf("dash.grid.len max %v, want MaxGridLen %d", m.Max, MaxGridLen)
			}
		}
	}
}
