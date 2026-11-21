package core

import "testing"

// Numbers outside the float64 range are number-shaped too: ParseFloat answers ±Inf with
// ErrRange, and they are refused like any other number (plan #62 r5-1). The bare forms are short;
// the padded and longer forms reach the ParseFloat checks.
func TestWeakPasswordOutOfRange(t *testing.T) {
	for _, p := range []string{
		" -2e+308", "-2e+308 ", "+2e+308 ", "-2e+308",
		"1e999", "-1e999", "1e999999", "-1e99999", "  1e999 ", " -1e999 ", "\t-1e999\n",
		"0x1p99999", "1e-99999",
	} {
		if !WeakPassword(p) {
			t.Errorf("%q is accepted as a password, want refused", p)
		}
	}
	for _, p := range []string{"abcd1234", "1e999-x-y", "2e+308pw"} {
		if WeakPassword(p) {
			t.Errorf("%q is refused, want accepted", p)
		}
	}
}
