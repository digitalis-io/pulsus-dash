// Package static holds the embedded client build, verified at start-up (ADR-0016).
package static

import (
	"crypto/ed25519"
	"io/fs"
)

// releasePublicKeys is set at build time:
// -ldflags "-X github.com/digitalis-io/pulsus-dash/server/internal/gateway/static.releasePublicKeys=<b64>[,<b64>]".
var releasePublicKeys string

// PublicKeys parses releasePublicKeys (standard base64, 32 bytes each, comma-separated).
func PublicKeys() ([]ed25519.PublicKey, error) { return nil, nil }

// Rep is one representation of a file: its bytes and its strong ETag.
type Rep struct {
	Bytes []byte
	ETag  string
}

// File is one logical file of the set with its encoded variants.
type File struct {
	Path        string
	ContentType string
	Identity    Rep
	Br, Gz      *Rep
}

// Set is the verified, read-only asset set.
type Set struct {
	files     map[string]*File
	Manifest  []byte
	Signature []byte
}

// Lookup returns the logical file at path.
func (s *Set) Lookup(path string) (*File, bool) { return nil, false }

// Len is the number of logical files (variants not counted).
func (s *Set) Len() int { return 0 }

// IntegrityError is a verification failure.
type IntegrityError struct{ Reason, Path, Expected, Actual string }

func (e *IntegrityError) Error() string { return "asset integrity check failed: " + e.Reason }

// Verify checks the signed manifest and every file of fsys.
func Verify(fsys fs.FS, keys []ed25519.PublicKey) (*Set, error) { return nil, nil }

// contentType maps a logical path's extension to its Content-Type.
func contentType(string) string { return "" }
