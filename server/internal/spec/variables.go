package spec

import (
	"regexp"
	"slices"
	"strconv"
	"strings"
	"unicode/utf8"

	"github.com/digitalis-io/pulsus-dash/server/internal/pulsusdb/vars"
	"github.com/digitalis-io/pulsus-dash/server/internal/varquery"
)

// The bounds of board spec v9's variables (#289 §3.1; the client's spec.ts has the same).
const (
	maxVariables          = 32
	maxVariableLabelRunes = 100
	maxVariableValues     = 200
	maxVariableValueRunes = 200
	maxVariableQueryBytes = 4096
	// allToken is All in a default (and in the address): ["$__all"].
	allToken = "$__all"
)

var (
	variableName  = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]{0,63}$`)
	variableRef   = regexp.MustCompile(`\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))`)
	variableKinds = []string{"query", "custom", "constant"}
	variableSorts = []string{"none", "alphaAsc", "alphaDesc", "numAsc", "numDesc"}
	refreshModes  = []string{"load", "timeChange"}
)

// referenced is the names text references (T09-010 syntax), macros ($__…) and names over 64 bytes
// aside: the client's referencedVariables.
func referenced(text string) []string {
	var out []string
	for _, m := range variableRef.FindAllStringSubmatch(text, -1) {
		n := m[1] + m[2]
		if strings.HasPrefix(n, "__") || !variableName.MatchString(n) || slices.Contains(out, n) {
			continue
		}
		out = append(out, n)
	}
	return out
}

// decodeEntry is a default entry as the address reads it (plan #289 §4.1): "$__all" is All; any
// other entry starting with $ loses one $.
func decodeEntry(e string) (value string, all bool) {
	if e == allToken {
		return "", true
	}
	if strings.HasPrefix(e, "$") {
		return e[1:], false
	}
	return e, false
}

// listValid is a values or default list: 1 to 200 entries, each 1 to 200 runes, no NUL.
func listValid(es []string) bool {
	if len(es) < 1 || len(es) > maxVariableValues {
		return false
	}
	for _, e := range es {
		n := utf8.RuneCountInString(e)
		if n < 1 || n > maxVariableValueRunes || strings.ContainsRune(e, 0) {
			return false
		}
	}
	return true
}

// variables checks board spec v9's variables (#289 §3.2), pointer /variables/<i>/<key>, in
// this order: the count; then per variable its name, label and kind, the kind's keys, allValue,
// values, query, sort, refresh and default.
func (v *validator) variables(vs []Variable) {
	if len(vs) > maxVariables {
		v.add("/variables", "board.variables.tooMany")
		return
	}
	for i, x := range vs {
		v.variable("/variables/"+strconv.Itoa(i), x, vs[:i], vs[i+1:])
	}
}

func (v *validator) variable(p string, x Variable, earlier, later []Variable) {
	key := func(k, rule string) string { return "board.variable." + k + "." + rule }
	switch {
	case !variableName.MatchString(x.Name) || strings.HasPrefix(x.Name, "__"):
		v.add(p+"/name", key("name", "invalid"))
	case slices.ContainsFunc(earlier, func(e Variable) bool { return e.Name == x.Name }):
		v.add(p+"/name", key("name", "duplicate"))
	}
	v.str(p+"/label", x.Label, func(s string) string {
		if utf8.RuneCountInString(s) > maxVariableLabelRunes {
			return key("label", "tooLong")
		}
		return ""
	})
	if !slices.Contains(variableKinds, x.Kind) {
		v.add(p+"/kind", key("kind", "invalid"))
		return
	}
	present := map[string]bool{"query": x.Query != nil, "values": x.Values != nil, "multi": x.Multi != nil,
		"includeAll": x.IncludeAll != nil, "allValue": x.AllValue != nil, "default": x.Default != nil,
		"sort": x.Sort != nil, "refresh": x.Refresh != nil}
	var required, forbidden []string
	switch x.Kind {
	case "query":
		required, forbidden = []string{"query", "multi", "includeAll", "sort", "refresh"}, []string{"values"}
	case "custom":
		required, forbidden = []string{"values", "multi", "includeAll", "sort"}, []string{"query", "refresh"}
	default: // constant
		required, forbidden = []string{"values"}, []string{"query", "multi", "includeAll", "allValue", "default", "sort", "refresh"}
	}
	for _, k := range required {
		if !present[k] {
			v.add(p, key(k, "required"))
		}
	}
	for _, k := range forbidden {
		if present[k] {
			v.add(p+"/"+k, key(k, "forbidden"))
		}
	}
	constant := x.Kind == "constant"
	if x.AllValue != nil && !constant {
		switch {
		case x.IncludeAll == nil || !*x.IncludeAll:
			v.add(p+"/allValue", key("allValue", "forbidden"))
		case len(*x.AllValue) < 1 || len(*x.AllValue) > vars.MaxValueBytes || strings.ContainsRune(*x.AllValue, 0):
			v.add(p+"/allValue", key("allValue", "invalid"))
		}
	}
	if x.Values != nil && x.Kind != "query" {
		dup := false
		for i, e := range x.Values {
			dup = dup || slices.Contains(x.Values[:i], e)
		}
		if !listValid(x.Values) || dup || (constant && len(x.Values) != 1) {
			v.add(p+"/values", key("values", "invalid"))
		}
	}
	if x.Query != nil && x.Kind == "query" {
		q := x.Query
		_, err := varquery.Parse(q.Lang, q.Text)
		switch {
		case !slices.Contains(queryLangs, q.Lang) || len(q.Text) > maxVariableQueryBytes || strings.ContainsRune(q.Text, 0) || err != nil:
			v.add(p+"/query", key("query", "invalid"))
		case slices.ContainsFunc(referenced(q.Text), func(n string) bool {
			return n == x.Name || slices.ContainsFunc(later, func(l Variable) bool { return l.Name == n })
		}):
			v.add(p+"/query", key("query", "order"))
		}
	}
	if x.Sort != nil && !constant && !slices.Contains(variableSorts, *x.Sort) {
		v.add(p+"/sort", key("sort", "invalid"))
	}
	if x.Refresh != nil && x.Kind == "query" && !slices.Contains(refreshModes, *x.Refresh) {
		v.add(p+"/refresh", key("refresh", "invalid"))
	}
	if x.Default != nil && !constant {
		v.defaults(p, x)
	}
}

// defaults is the default rules (#289 §3.2): a valid list; no duplicates (decoded); at most one
// entry unless multi; $__all only with includeAll and alone; a custom entry (decoded) among
// values; then a multi default's decoded JSON array at most 65 536 bytes.
func (v *validator) defaults(p string, x Variable) {
	invalid := func() { v.add(p+"/default", "board.variable.default.invalid") }
	if !listValid(x.Default) {
		invalid()
		return
	}
	multi := x.Multi != nil && *x.Multi
	includeAll := x.IncludeAll != nil && *x.IncludeAll
	var decoded []string
	all := false
	for _, e := range x.Default {
		d, isAll := decodeEntry(e)
		switch {
		case isAll:
			if all || !includeAll {
				invalid()
				return
			}
			all = true
		case d == "" || slices.Contains(decoded, d), x.Kind == "custom" && !slices.Contains(x.Values, d):
			invalid()
			return
		default:
			decoded = append(decoded, d)
		}
	}
	if (all && len(decoded) > 0) || (!multi && len(x.Default) > 1) {
		invalid()
		return
	}
	if multi && vars.SelectionBytes(decoded) > vars.MaxSelectionBytes {
		v.add(p+"/default", "board.variable.default.tooLarge")
	}
}
