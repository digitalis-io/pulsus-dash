// Package keyhash computes the series key of T04-004: xxh3_64 over the canonical label set.
package keyhash

// Label is one label of a series.
type Label struct{ Name, Value string }

// Labels returns the key of the label set.
func Labels(ls []Label) uint64 {
	_ = ls
	return 0
}

// Hex is 16 lower-case hex digits.
func Hex(k uint64) string {
	_ = k
	return ""
}
