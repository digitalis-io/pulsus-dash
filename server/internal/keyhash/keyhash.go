// Package keyhash computes the series key of T04-004: xxh3_64 (seed 0) over the canonical label
// set. The browser receives the key as 16 lower-case hex digits (SeriesFrame.key).
package keyhash

import (
	"slices"
	"strconv"
	"strings"

	"github.com/zeebo/xxh3"
)

// Label is one label of a series.
type Label struct{ Name, Value string }

// sep ends every name and value of the canonical form. 0xFF never occurs in UTF-8, so the form
// is unambiguous.
const sep = 0xFF

// Labels returns xxh3_64 of the canonical label set: labels sorted by name (byte order; equal
// names by value), each written as name, 0xFF, value, 0xFF. The input need not be sorted and is
// not modified.
func Labels(ls []Label) uint64 {
	sorted := ls
	if !slices.IsSortedFunc(ls, compare) {
		sorted = slices.Clone(ls)
		slices.SortFunc(sorted, compare)
	}
	n := 0
	for _, l := range sorted {
		n += len(l.Name) + len(l.Value) + 2
	}
	b := make([]byte, 0, n)
	for _, l := range sorted {
		b = append(b, l.Name...)
		b = append(b, sep)
		b = append(b, l.Value...)
		b = append(b, sep)
	}
	return xxh3.Hash(b)
}

func compare(a, b Label) int {
	if c := strings.Compare(a.Name, b.Name); c != 0 {
		return c
	}
	return strings.Compare(a.Value, b.Value)
}

// Text is xxh3_64 (seed 0) of the bytes of s. #65 Part B binds a log page cursor to its query
// text with it.
func Text(s string) uint64 { return xxh3.HashString(s) }

// Hex is 16 lower-case hex digits (the client's KEY_PATTERN ^[0-9a-f]{16}$).
func Hex(k uint64) string {
	s := strconv.FormatUint(k, 16)
	if len(s) < 16 {
		s = strings.Repeat("0", 16-len(s)) + s
	}
	return s
}
