// Package static holds the embedded client build, verified at start-up (ADR-0016). The bytes it
// serves are only those Verify checked against the signed manifest; nothing is read from disk
// after start-up.
package static

import (
	"crypto/ed25519"
	"crypto/sha512"
	"encoding/base64"
	"fmt"
	"path"
	"strconv"
	"strings"
)

// releasePublicKeys is set at build time:
// -ldflags "-X github.com/digitalis-io/pulsus-dash/server/internal/gateway/static.releasePublicKeys=<b64>[,<b64>]".
// More than one key allows rotation (T18-006).
var releasePublicKeys string

// PublicKeys parses releasePublicKeys (standard base64, 32 bytes each, comma-separated). An empty
// value gives no keys, which Verify refuses with no_public_key.
func PublicKeys() ([]ed25519.PublicKey, error) {
	keys := []ed25519.PublicKey{}
	if strings.TrimSpace(releasePublicKeys) == "" {
		return keys, nil
	}
	for i, part := range strings.Split(releasePublicKeys, ",") {
		b, err := base64.StdEncoding.DecodeString(strings.TrimSpace(part))
		if err != nil || len(b) != ed25519.PublicKeySize {
			return nil, fmt.Errorf("static: release public key %d is not %d bytes of standard base64", i+1, ed25519.PublicKeySize)
		}
		keys = append(keys, ed25519.PublicKey(b))
	}
	return keys, nil
}

// Rep is one representation of a file: its bytes and its strong ETag.
type Rep struct {
	Bytes []byte
	// ETag is `"` + the first 22 characters of base64url(SHA-384 of Bytes) + `"`, so each
	// representation (identity, br, gzip) has its own validator.
	ETag string
}

// NewRep returns the representation of b with its ETag.
func NewRep(b []byte) Rep {
	sum := sha512.Sum384(b)
	return Rep{Bytes: b, ETag: `"` + base64.RawURLEncoding.EncodeToString(sum[:])[:22] + `"`}
}

// File is one logical file of the set with its encoded variants.
type File struct {
	Path        string // "index.html", "assets/index-3fA9.js"
	ContentType string
	Identity    Rep
	Br, Gz      *Rep // nil when absent
}

// Set is the verified asset set. It is read-only after Verify and shared without locks.
type Set struct {
	files     map[string]*File
	Manifest  []byte // the exact bytes whose signature was verified
	Signature []byte // the exact 64 verified bytes
}

// Lookup returns the logical file at path ("assets/x.js", no leading slash).
func (s *Set) Lookup(path string) (*File, bool) {
	f, ok := s.files[path]
	return f, ok
}

// Len is the number of logical files (variants not counted).
func (s *Set) Len() int { return len(s.files) }

// IntegrityError is a verification failure. Expected and Actual are sizes (size_mismatch) or
// base64 digests (hash_mismatch), else empty.
type IntegrityError struct{ Reason, Path, Expected, Actual string }

// The reasons of IntegrityError.
const (
	ReasonNoPublicKey      = "no_public_key"
	ReasonMissingManifest  = "missing_manifest"
	ReasonMissingSignature = "missing_signature"
	ReasonBadSignature     = "bad_signature"
	ReasonBadManifest      = "bad_manifest"
	ReasonWalkError        = "walk_error"
	ReasonReadError        = "read_error"
	ReasonUnexpectedEntry  = "unexpected_entry"
	ReasonMissingFile      = "missing_file"
	ReasonUnlistedFile     = "unlisted_file"
	ReasonSizeMismatch     = "size_mismatch"
	ReasonHashMismatch     = "hash_mismatch"
)

// Error is "asset integrity check failed: <reason>[ <path>]".
func (e *IntegrityError) Error() string {
	s := "asset integrity check failed: " + e.Reason
	if e.Path != "" {
		s += " " + e.Path
	}
	return s
}

func sizeMismatch(p string, want, got int64) *IntegrityError {
	return &IntegrityError{Reason: ReasonSizeMismatch, Path: p, Expected: strconv.FormatInt(want, 10), Actual: strconv.FormatInt(got, 10)}
}

var contentTypes = map[string]string{
	".html":  "text/html; charset=utf-8",
	".js":    "text/javascript; charset=utf-8",
	".mjs":   "text/javascript; charset=utf-8",
	".css":   "text/css; charset=utf-8",
	".json":  "application/json",
	".map":   "application/json",
	".svg":   "image/svg+xml",
	".woff2": "font/woff2",
	".wasm":  "application/wasm",
	".png":   "image/png",
	".ico":   "image/x-icon",
	".txt":   "text/plain; charset=utf-8",
}

// contentType maps a logical path's extension to its Content-Type (plan #59 B.3).
func contentType(p string) string {
	if ct, ok := contentTypes[path.Ext(p)]; ok {
		return ct
	}
	return "application/octet-stream"
}
