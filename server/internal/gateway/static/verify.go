package static

import (
	"bytes"
	"crypto/ed25519"
	"crypto/sha512"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"io/fs"
	"strings"
)

// The two files the manifest does not list.
const (
	manifestName  = "asset-manifest.json"
	signatureName = "asset-manifest.sig"
)

type manifestDoc struct {
	Version int               `json:"version"`
	Files   []json.RawMessage `json:"files"`
}

type manifestEntry struct {
	Path   string `json:"path"`
	SHA384 string `json:"sha384"`
	Size   int64  `json:"size"`
}

// Verify checks the signed manifest and every file of fsys, in the order of plan #59 B.3, and
// returns the verified set. The first failure is returned as an *IntegrityError; no set exists
// until every check has passed.
func Verify(fsys fs.FS, keys []ed25519.PublicKey) (*Set, error) {
	// 1. Keys.
	if len(keys) == 0 {
		return nil, &IntegrityError{Reason: ReasonNoPublicKey}
	}
	// 2. Manifest and signature.
	manifest, err := readAll(fsys, manifestName)
	if err != nil {
		return nil, missingOr(err, ReasonMissingManifest, manifestName)
	}
	sig, err := readAll(fsys, signatureName)
	if err != nil {
		return nil, missingOr(err, ReasonMissingSignature, signatureName)
	}
	// 3. Signature over the exact bytes.
	if !signedBySome(keys, manifest, sig) {
		return nil, &IntegrityError{Reason: ReasonBadSignature}
	}
	// 4. Strict manifest.
	entries, err := parseManifest(manifest)
	if err != nil {
		return nil, err
	}
	listed := make(map[string]manifestEntry, len(entries))
	for _, e := range entries {
		listed[e.Path] = e
	}
	// 5. The tree holds only directories and listed regular files.
	if err := walk(fsys, listed); err != nil {
		return nil, err
	}
	// 6-8. Each listed file: present, regular, the listed size, the listed hash.
	reps := make(map[string]Rep, len(entries))
	for _, e := range entries {
		b, err := readListed(fsys, e)
		if err != nil {
			return nil, err
		}
		reps[e.Path] = NewRep(b)
	}
	set := &Set{files: map[string]*File{}, Manifest: manifest, Signature: sig}
	for _, e := range entries {
		if isVariant(e.Path) {
			continue
		}
		f := &File{Path: e.Path, ContentType: contentType(e.Path), Identity: reps[e.Path]}
		if r, ok := reps[e.Path+".br"]; ok {
			f.Br = &r
		}
		if r, ok := reps[e.Path+".gz"]; ok {
			f.Gz = &r
		}
		set.files[e.Path] = f
	}
	return set, nil
}

func signedBySome(keys []ed25519.PublicKey, msg, sig []byte) bool {
	if len(sig) != ed25519.SignatureSize {
		return false
	}
	for _, k := range keys {
		if len(k) == ed25519.PublicKeySize && ed25519.Verify(k, msg, sig) {
			return true
		}
	}
	return false
}

func missingOr(err error, missing, path string) *IntegrityError {
	if errors.Is(err, fs.ErrNotExist) {
		return &IntegrityError{Reason: missing}
	}
	return &IntegrityError{Reason: ReasonReadError, Path: path}
}

// readAll opens and reads name through fsys.Open, so every Open and Read error is seen.
func readAll(fsys fs.FS, name string) ([]byte, error) {
	f, err := fsys.Open(name)
	if err != nil {
		return nil, err
	}
	defer func() { _ = f.Close() }()
	return io.ReadAll(f)
}

func isVariant(p string) bool { return strings.HasSuffix(p, ".br") || strings.HasSuffix(p, ".gz") }

func badManifest(p string) *IntegrityError {
	return &IntegrityError{Reason: ReasonBadManifest, Path: p}
}

// parseManifest is step 4: one strict JSON value, version 1, valid unique sorted paths, sizes and
// digests, and no variant without its base entry.
func parseManifest(b []byte) ([]manifestEntry, error) {
	var doc manifestDoc
	dec := json.NewDecoder(bytes.NewReader(b))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&doc); err != nil {
		return nil, badManifest("")
	}
	if _, err := dec.Token(); !errors.Is(err, io.EOF) {
		return nil, badManifest("")
	}
	if doc.Version != 1 {
		return nil, badManifest("")
	}
	entries := make([]manifestEntry, 0, len(doc.Files))
	seen := make(map[string]bool, len(doc.Files))
	for i, raw := range doc.Files {
		var loose struct {
			Path string `json:"path"`
		}
		_ = json.Unmarshal(raw, &loose)
		name := loose.Path
		var e manifestEntry
		d := json.NewDecoder(bytes.NewReader(raw))
		d.DisallowUnknownFields()
		if err := d.Decode(&e); err != nil {
			return nil, badManifest(name)
		}
		if !fs.ValidPath(e.Path) || e.Path == "." || hasDotDot(e.Path) || e.Path == manifestName || e.Path == signatureName {
			return nil, badManifest(e.Path)
		}
		if seen[e.Path] || (i > 0 && e.Path <= entries[i-1].Path) {
			return nil, badManifest(e.Path)
		}
		seen[e.Path] = true
		if e.Size < 0 {
			return nil, badManifest(e.Path)
		}
		if d, err := base64.StdEncoding.DecodeString(e.SHA384); err != nil || len(d) != sha512.Size384 {
			return nil, badManifest(e.Path)
		}
		entries = append(entries, e)
	}
	for _, e := range entries {
		if isVariant(e.Path) && !seen[e.Path[:len(e.Path)-3]] {
			return nil, badManifest(e.Path)
		}
	}
	return entries, nil
}

func hasDotDot(p string) bool {
	for _, seg := range strings.Split(p, "/") {
		if seg == ".." {
			return true
		}
	}
	return false
}

// walk is step 5. The walk stops at the first error.
func walk(fsys fs.FS, listed map[string]manifestEntry) error {
	var bad *IntegrityError
	err := fs.WalkDir(fsys, ".", func(p string, d fs.DirEntry, err error) error {
		switch {
		case err != nil:
			bad = &IntegrityError{Reason: ReasonWalkError, Path: p}
		case d.IsDir():
			return nil
		case !d.Type().IsRegular():
			bad = &IntegrityError{Reason: ReasonUnexpectedEntry, Path: p}
		case p == manifestName || p == signatureName:
			return nil
		default:
			if _, ok := listed[p]; ok {
				return nil
			}
			bad = &IntegrityError{Reason: ReasonUnlistedFile, Path: p}
		}
		return fs.SkipAll
	})
	if bad != nil {
		return bad
	}
	if err != nil {
		return &IntegrityError{Reason: ReasonWalkError, Path: "."}
	}
	return nil
}

// readListed is steps 6-8 for one entry. At most size+1 bytes are read, so an oversized file is
// never held in memory.
func readListed(fsys fs.FS, e manifestEntry) ([]byte, error) {
	info, err := fs.Stat(fsys, e.Path)
	if errors.Is(err, fs.ErrNotExist) {
		return nil, &IntegrityError{Reason: ReasonMissingFile, Path: e.Path}
	}
	if err != nil {
		return nil, &IntegrityError{Reason: ReasonReadError, Path: e.Path}
	}
	if !info.Mode().IsRegular() {
		return nil, &IntegrityError{Reason: ReasonUnexpectedEntry, Path: e.Path}
	}
	if info.Size() != e.Size {
		return nil, sizeMismatch(e.Path, e.Size, info.Size())
	}
	f, err := fsys.Open(e.Path)
	if errors.Is(err, fs.ErrNotExist) {
		return nil, &IntegrityError{Reason: ReasonMissingFile, Path: e.Path}
	}
	if err != nil {
		return nil, &IntegrityError{Reason: ReasonReadError, Path: e.Path}
	}
	defer func() { _ = f.Close() }()
	b, err := io.ReadAll(io.LimitReader(f, e.Size+1))
	if err != nil {
		return nil, &IntegrityError{Reason: ReasonReadError, Path: e.Path}
	}
	if int64(len(b)) != e.Size {
		return nil, sizeMismatch(e.Path, e.Size, int64(len(b)))
	}
	sum := sha512.Sum384(b)
	if got := base64.StdEncoding.EncodeToString(sum[:]); got != e.SHA384 {
		return nil, &IntegrityError{Reason: ReasonHashMismatch, Path: e.Path, Expected: e.SHA384, Actual: got}
	}
	return b, nil
}
