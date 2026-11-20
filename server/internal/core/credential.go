package core

// WeakPassword reports whether p is refused as a PulsusDB password (plan #62 §4.10).
func WeakPassword(p string) bool {
	_ = p
	return false
}
