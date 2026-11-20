package config

import "errors"

// Resolve is not implemented yet.
func (r SecretRef) Resolve(src Sources, allowInline bool) (string, error) {
	return "", errors.New("not implemented")
}

// ResolveRef is not implemented yet.
func (c *Config) ResolveRef(key string, r SecretRef, src Sources) (string, error) {
	return "", errors.New("not implemented")
}
