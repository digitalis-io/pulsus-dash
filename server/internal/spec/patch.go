package spec

import (
	"bytes"
	"slices"
	"strconv"
)

// Diff returns the RFC 6902 patch from one canonical JSON document to another (plan #61 §3.4.2),
// as canonical JSON: objects recurse key by key in sorted order (remove, add, or recurse), arrays
// recurse on the common indices then remove from the end and add at the end, and anything else
// is replaced. Equal documents give []; from == nil gives one add of the whole document at "".
func Diff(from, to []byte) ([]byte, error) {
	b, err := decodeValue(to)
	if err != nil {
		return nil, err
	}
	if from == nil {
		return Canonical([]any{map[string]any{"op": "add", "path": "", "value": b}})
	}
	a, err := decodeValue(from)
	if err != nil {
		return nil, err
	}
	ops := []any{}
	if err := diffValue("", a, b, &ops); err != nil {
		return nil, err
	}
	return Canonical(ops)
}

func equal(a, b any) (bool, error) {
	ca, err := encodeValue(a)
	if err != nil {
		return false, err
	}
	cb, err := encodeValue(b)
	if err != nil {
		return false, err
	}
	return bytes.Equal(ca, cb), nil
}

func diffValue(path string, a, b any, ops *[]any) error {
	if same, err := equal(a, b); err != nil || same {
		return err
	}
	switch av := a.(type) {
	case map[string]any:
		if bv, ok := b.(map[string]any); ok {
			return diffObject(path, av, bv, ops)
		}
	case []any:
		if bv, ok := b.([]any); ok {
			return diffArray(path, av, bv, ops)
		}
	}
	*ops = append(*ops, map[string]any{"op": "replace", "path": path, "value": b})
	return nil
}

func diffObject(path string, a, b map[string]any, ops *[]any) error {
	keys := make([]string, 0, len(a)+len(b))
	for k := range a {
		keys = append(keys, k)
	}
	for k := range b {
		if _, ok := a[k]; !ok {
			keys = append(keys, k)
		}
	}
	slices.Sort(keys)
	for _, k := range keys {
		p := path + "/" + escapePointer(k)
		av, inA := a[k]
		bv, inB := b[k]
		switch {
		case !inB:
			*ops = append(*ops, map[string]any{"op": "remove", "path": p})
		case !inA:
			*ops = append(*ops, map[string]any{"op": "add", "path": p, "value": bv})
		default:
			if err := diffValue(p, av, bv, ops); err != nil {
				return err
			}
		}
	}
	return nil
}

func diffArray(path string, a, b []any, ops *[]any) error {
	common := min(len(a), len(b))
	for i := range common {
		if err := diffValue(path+"/"+strconv.Itoa(i), a[i], b[i], ops); err != nil {
			return err
		}
	}
	for i := len(a) - 1; i >= len(b); i-- {
		*ops = append(*ops, map[string]any{"op": "remove", "path": path + "/" + strconv.Itoa(i)})
	}
	for i := len(a); i < len(b); i++ {
		*ops = append(*ops, map[string]any{"op": "add", "path": path + "/" + strconv.Itoa(i), "value": b[i]})
	}
	return nil
}
