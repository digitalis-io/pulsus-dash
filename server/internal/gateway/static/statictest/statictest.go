// Package statictest builds signed asset trees for tests, laid out as client/scripts/pack-assets.ts
// writes them (plan #59 B.2): every file, its manifest entry and a detached Ed25519 signature.
package statictest

import (
	"crypto/ed25519"
	"crypto/sha512"
	"encoding/base64"
	"encoding/json"
	"sort"
	"testing/fstest"
)

// ManifestName and SignatureName are the two files the manifest does not list.
const (
	ManifestName  = "asset-manifest.json"
	SignatureName = "asset-manifest.sig"
)

// IndexHTML and AppJS are the identity bytes of the default files. AppBr and AppGz stand in for
// the encoded variants: verification checks only their hashes, so any bytes will do.
var (
	IndexHTML = []byte("<!doctype html><html><head><script type=\"module\" src=\"/assets/app.js\"></script></head><body><div id=\"root\"></div></body></html>\n")
	AppJS     = []byte("export const answer = 42;\nconsole.log('pulsus-dash test asset', answer);\n")
	AppBr     = []byte("br:fake-brotli-bytes")
	AppGz     = []byte("gz:fake-gzip-bytes")
)

// Key returns the fixed test signing key; Key2 a second, different key.
func Key() ed25519.PrivateKey  { return ed25519.NewKeyFromSeed(seed(1)) }
func Key2() ed25519.PrivateKey { return ed25519.NewKeyFromSeed(seed(2)) }

func seed(b byte) []byte {
	s := make([]byte, ed25519.SeedSize)
	for i := range s {
		s[i] = b
	}
	return s
}

// Public returns the public half of k.
func Public(k ed25519.PrivateKey) ed25519.PublicKey { return k.Public().(ed25519.PublicKey) }

// DefaultFiles is index.html and assets/app.js with its .br and .gz variants.
func DefaultFiles() map[string][]byte {
	return map[string][]byte{
		"index.html":       IndexHTML,
		"assets/app.js":    AppJS,
		"assets/app.js.br": AppBr,
		"assets/app.js.gz": AppGz,
	}
}

// Entry is one manifest entry.
type Entry struct {
	Path   string `json:"path"`
	SHA384 string `json:"sha384"`
	Size   int64  `json:"size"`
}

// Manifest is the manifest document.
type Manifest struct {
	Version int     `json:"version"`
	Files   []Entry `json:"files"`
}

// Entries returns the sorted manifest entries of files.
func Entries(files map[string][]byte) []Entry {
	out := make([]Entry, 0, len(files))
	for p, b := range files {
		sum := sha512.Sum384(b)
		out = append(out, Entry{Path: p, SHA384: base64.StdEncoding.EncodeToString(sum[:]), Size: int64(len(b))})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Path < out[j].Path })
	return out
}

// Encode writes m as pack-assets.ts does: two-space indentation and a final newline.
func Encode(m Manifest) []byte {
	b, err := json.MarshalIndent(m, "", "  ")
	if err != nil {
		panic(err) // a Manifest always marshals
	}
	return append(b, '\n')
}

// Build returns a tree with files, their manifest and its signature by key.
func Build(files map[string][]byte, key ed25519.PrivateKey) fstest.MapFS {
	return BuildManifest(files, Encode(Manifest{Version: 1, Files: Entries(files)}), key)
}

// BuildManifest returns a tree with files, the given manifest bytes and their signature by key.
func BuildManifest(files map[string][]byte, manifest []byte, key ed25519.PrivateKey) fstest.MapFS {
	fsys := fstest.MapFS{}
	for p, b := range files {
		fsys[p] = &fstest.MapFile{Data: b, Mode: 0o644}
	}
	fsys[ManifestName] = &fstest.MapFile{Data: manifest, Mode: 0o644}
	fsys[SignatureName] = &fstest.MapFile{Data: ed25519.Sign(key, manifest), Mode: 0o644}
	return fsys
}

// Default is Build(DefaultFiles(), Key()).
func Default() fstest.MapFS { return Build(DefaultFiles(), Key()) }
