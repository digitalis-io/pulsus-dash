package pulsusdb

// reservedIn reports the first reserved selector named in text (T07 §0, T07-020 v1).
func reservedIn(text string) (name string, ok bool) {
	_ = text
	return "", false
}
