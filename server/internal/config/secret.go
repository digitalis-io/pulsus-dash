package config

import (
	"errors"
	"fmt"
	"io"
	"os"
	"regexp"
	"strings"
)

// envRef is the syntax of an env: reference.
var envRef = regexp.MustCompile(`^env:[A-Za-z_][A-Za-z0-9_]{0,127}$`)

// maxFilePath bounds the PATH of a file: reference, in bytes.
const maxFilePath = 1023

// validFileRef reports whether s is file:PATH with PATH absolute (starting with "/"), 1 to 1023
// bytes long, and free of ASCII whitespace and control characters (bytes 0x00-0x20 and 0x7F);
// other bytes, including multibyte UTF-8, are allowed. The tenant_bindings.credentials_ref CHECK of
// migration 1 states the same rule byte-wise (octet_length and an explicit byte class), so it does
// not depend on the database locale.
func validFileRef(s string) bool {
	path, ok := strings.CutPrefix(s, "file:")
	if !ok || len(path) < 1 || len(path) > maxFilePath || path[0] != '/' {
		return false
	}
	for i := 0; i < len(path); i++ {
		if b := path[i]; b <= 0x20 || b == 0x7f {
			return false
		}
	}
	return true
}

// maxSecretFile bounds a file: reference.
const maxSecretFile = 64 * 1024

const (
	msgRefSyntax = "must be env:NAME or file:/absolute/path"
	msgVault     = "vault references are not supported in this release"
	msgInline    = "inline secrets are refused; use env:NAME or file:PATH (or set allow_inline_secrets: true for development)"
)

type refKind int

const (
	refEnv refKind = iota
	refFile
	refVault
	refInline
)

func (r SecretRef) kind() refKind {
	s := string(r)
	switch {
	case strings.HasPrefix(s, "env:"):
		return refEnv
	case strings.HasPrefix(s, "file:"):
		return refFile
	case strings.HasPrefix(s, "vault://"):
		return refVault
	default:
		return refInline
	}
}

// IsInline reports whether the value is a literal rather than a reference.
func (r SecretRef) IsInline() bool { return r != "" && r.kind() == refInline }

// check validates the reference without reading anything.
func (r SecretRef) check(allowInline bool) error {
	switch r.kind() {
	case refEnv:
		if !envRef.MatchString(string(r)) {
			return errors.New(msgRefSyntax)
		}
	case refFile:
		if !validFileRef(string(r)) {
			return errors.New(msgRefSyntax)
		}
	case refVault:
		return errors.New(msgVault)
	case refInline:
		if !allowInline {
			return errors.New(msgInline)
		}
	}
	return nil
}

// Resolve returns the secret a reference names (T19-010): env:NAME reads NAME from src.Environ;
// file:PATH reads the file (at most 64 KiB, one trailing newline trimmed); a literal is returned
// only with allowInline. Errors never contain a value or a literal.
func (r SecretRef) Resolve(src Sources, allowInline bool) (string, error) {
	if err := r.check(allowInline); err != nil {
		return "", err
	}
	s := string(r)
	switch r.kind() {
	case refEnv:
		name := strings.TrimPrefix(s, "env:")
		for _, kv := range src.Environ {
			if k, v, ok := strings.Cut(kv, "="); ok && k == name {
				return v, nil
			}
		}
		return "", fmt.Errorf("environment variable %s is not set", name)
	case refFile:
		path := strings.TrimPrefix(s, "file:")
		b, err := readSecretFile(src, path)
		if err != nil {
			return "", fmt.Errorf("cannot read file %s", path)
		}
		if len(b) > maxSecretFile {
			return "", fmt.Errorf("file %s is larger than 64 KiB", path)
		}
		v := string(b)
		if t, ok := strings.CutSuffix(v, "\r\n"); ok {
			return t, nil
		}
		return strings.TrimSuffix(v, "\n"), nil
	default:
		return s, nil
	}
}

// readSecretFile reads at most one byte more than the limit, so an oversized file is detected
// without reading all of it.
func readSecretFile(src Sources, path string) ([]byte, error) {
	if src.ReadFile != nil {
		return src.ReadFile(path)
	}
	f, err := os.Open(path) // #nosec G304 -- the operator names the file in the configuration
	if err != nil {
		return nil, err
	}
	defer func() { _ = f.Close() }()
	return io.ReadAll(io.LimitReader(f, maxSecretFile+1))
}

// ResolveRef resolves the reference at key, honouring allow_inline_secrets, and returns errors as
// "config: <key>: <message>".
func (c *Config) ResolveRef(key string, r SecretRef, src Sources) (string, error) {
	v, err := r.Resolve(src, c.AllowInlineSecrets)
	if err != nil {
		return "", &Error{Key: key, Msg: err.Error()}
	}
	return v, nil
}
