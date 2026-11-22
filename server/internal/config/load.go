package config

import (
	"bytes"
	"errors"
	"fmt"
	"io"
	"os"
	"reflect"
	"slices"
	"strconv"
	"strings"
	"time"

	"go.yaml.in/yaml/v3"
)

// envPrefix starts every configuration variable.
const envPrefix = "PULSUS_DASH_"

// leaf is one scalar (or list) key of Config, found by a reflective walk of the yaml tags.
type leaf struct {
	path  string // "server.listen"
	env   string // "PULSUS_DASH_SERVER_LISTEN"
	index []int  // field index path from Config
	typ   reflect.Type
}

var durationType = reflect.TypeFor[Duration]()

// leaves lists every key of Config.
func leaves() []leaf {
	var out []leaf
	var walk func(t reflect.Type, prefix string, index []int)
	walk = func(t reflect.Type, prefix string, index []int) {
		for i := range t.NumField() {
			f := t.Field(i)
			if !f.IsExported() {
				continue // Config.src: where the file came from, not a key
			}
			tag := strings.Split(f.Tag.Get("yaml"), ",")[0]
			path := tag
			if prefix != "" {
				path = prefix + "." + tag
			}
			idx := append(slices.Clone(index), i)
			if f.Type.Kind() == reflect.Struct && f.Type != durationType {
				walk(f.Type, path, idx)
				continue
			}
			env := envPrefix + strings.ToUpper(strings.ReplaceAll(path, ".", "_"))
			out = append(out, leaf{path: path, env: env, index: idx, typ: f.Type})
		}
	}
	walk(reflect.TypeFor[Config](), "", nil)
	return out
}

// Load builds the configuration: defaults, then the YAML file (if any), then PULSUS_DASH_*
// variables. Keys and types are strict (T06-019). Every non-seed key is validated; the seed keys
// (datasource.*, bootstrap.*) are checked only for their type here and for their values by
// SeedSettings.
func Load(src Sources) (*Config, error) {
	cfg := defaults()
	if src.ConfigPath != "" {
		read := src.ReadFile
		if read == nil {
			read = os.ReadFile
		}
		b, err := read(src.ConfigPath)
		if err != nil {
			return nil, &Error{Msg: "cannot read file " + src.ConfigPath}
		}
		if err := decodeYAML(b, cfg); err != nil {
			return nil, err
		}
	}
	if err := applyEnv(src.Environ, cfg); err != nil {
		return nil, err
	}
	if err := cfg.validate(); err != nil {
		return nil, err
	}
	cfg.src = src
	return cfg, nil
}

// decodeYAML runs the three strict passes over b.
func decodeYAML(b []byte, cfg *Config) error {
	// Pass 1: exactly one document.
	dec := yaml.NewDecoder(bytes.NewReader(b))
	var doc yaml.Node
	if err := dec.Decode(&doc); err != nil {
		if errors.Is(err, io.EOF) {
			return nil // an empty file: defaults only
		}
		return &Error{Msg: err.Error()}
	}
	var extra yaml.Node
	if err := dec.Decode(&extra); !errors.Is(err, io.EOF) {
		return &Error{Msg: "the file must contain one YAML document"}
	}
	root := &doc
	if root.Kind == yaml.DocumentNode && len(root.Content) == 1 {
		root = root.Content[0]
	}
	if root.Kind == yaml.ScalarNode && root.Tag == "!!null" {
		return nil // only comments
	}
	// Pass 2: structure, unknown and duplicate keys.
	if err := walkNode(root, reflect.TypeFor[Config](), ""); err != nil {
		return err
	}
	// Pass 3: value conversion into the defaults.
	d := yaml.NewDecoder(bytes.NewReader(b))
	d.KnownFields(true)
	if err := d.Decode(cfg); err != nil {
		return &Error{Msg: err.Error()}
	}
	return nil
}

func walkNode(n *yaml.Node, t reflect.Type, path string) error {
	switch {
	case t.Kind() == reflect.Struct && t != durationType:
		if n.Kind != yaml.MappingNode {
			if path == "" {
				return &Error{Line: n.Line, Msg: "the file must be a YAML mapping"}
			}
			return &Error{Key: path, Line: n.Line, Msg: "must be a mapping"}
		}
		seen := map[string]bool{}
		for i := 0; i+1 < len(n.Content); i += 2 {
			k, v := n.Content[i], n.Content[i+1]
			full := k.Value
			if path != "" {
				full = path + "." + k.Value
			}
			if seen[k.Value] {
				return &Error{Line: k.Line, Msg: fmt.Sprintf("duplicate key %q", full)}
			}
			seen[k.Value] = true
			f, ok := fieldByTag(t, k.Value)
			if k.Kind != yaml.ScalarNode || !ok {
				return &Error{Line: k.Line, Msg: fmt.Sprintf("unknown key %q", full)}
			}
			if err := walkNode(v, f.Type, full); err != nil {
				return err
			}
		}
		return nil
	case t.Kind() == reflect.Slice:
		if n.Kind != yaml.SequenceNode {
			return &Error{Key: path, Line: n.Line, Msg: "must be a list of strings"}
		}
		for _, item := range n.Content {
			if item.Kind != yaml.ScalarNode {
				return &Error{Key: path, Line: item.Line, Msg: "must be a list of strings"}
			}
		}
		return nil
	default:
		if n.Kind != yaml.ScalarNode {
			return &Error{Key: path, Line: n.Line, Msg: scalarMsg(t)}
		}
		return nil
	}
}

func fieldByTag(t reflect.Type, key string) (reflect.StructField, bool) {
	for i := range t.NumField() {
		f := t.Field(i)
		if strings.Split(f.Tag.Get("yaml"), ",")[0] == key {
			return f, true
		}
	}
	return reflect.StructField{}, false
}

// scalarMsg is the type error of a scalar key.
func scalarMsg(t reflect.Type) string {
	switch {
	case t == durationType:
		return "must be a duration"
	case t.Kind() == reflect.Bool:
		return "must be true or false"
	case t.Kind() == reflect.Int32:
		return "must be an integer"
	default:
		return "must be a string"
	}
}

// applyEnv overlays PULSUS_DASH_* variables. A variable that is neither a key nor a ClientVar is
// an error; a value that does not parse names the variable.
func applyEnv(environ []string, cfg *Config) error {
	byEnv := map[string]leaf{}
	for _, l := range leaves() {
		byEnv[l.env] = l
	}
	root := reflect.ValueOf(cfg).Elem()
	for _, kv := range environ {
		name, val, _ := strings.Cut(kv, "=")
		if !strings.HasPrefix(name, envPrefix) {
			continue
		}
		l, ok := byEnv[name]
		if !ok {
			if slices.Contains(ClientVars, name) {
				continue
			}
			return &Error{Msg: "unknown environment variable " + name}
		}
		if err := setFromEnv(root.FieldByIndex(l.index), l.typ, val); err != nil {
			return &Error{Key: name, Msg: err.Error()}
		}
	}
	return nil
}

func setFromEnv(v reflect.Value, t reflect.Type, s string) error {
	switch {
	case t == durationType:
		d, err := time.ParseDuration(s)
		if err != nil {
			return errors.New(scalarMsg(t))
		}
		v.SetInt(int64(d))
	case t.Kind() == reflect.Bool:
		switch s {
		case "true":
			v.SetBool(true)
		case "false":
			v.SetBool(false)
		default:
			return errors.New(scalarMsg(t))
		}
	case t.Kind() == reflect.Int32:
		n, err := strconv.ParseInt(s, 10, 32)
		if err != nil {
			return errors.New(scalarMsg(t))
		}
		v.SetInt(n)
	case t.Kind() == reflect.Slice:
		var items []string
		for _, p := range strings.Split(s, ",") {
			if p = strings.TrimSpace(p); p != "" {
				items = append(items, p)
			}
		}
		v.Set(reflect.ValueOf(items))
	default:
		v.SetString(s)
	}
	return nil
}
