package static

import (
	"bytes"
	"crypto/ed25519"
	"encoding/base64"
	"errors"
	"io"
	"io/fs"
	"testing"
	"testing/fstest"
	"time"

	"github.com/digitalis-io/pulsus-dash/server/internal/gateway/static/statictest"
)

func pub() []ed25519.PublicKey { return []ed25519.PublicKey{statictest.Public(statictest.Key())} }

// wantIntegrity checks that err is an *IntegrityError with the reason and path.
func wantIntegrity(t *testing.T, set *Set, err error, reason, path string) IntegrityError {
	t.Helper()
	if set != nil {
		t.Errorf("Verify returned a set with error %v", err)
	}
	var ie *IntegrityError
	if !errors.As(err, &ie) {
		t.Fatalf("err = %v, want *IntegrityError %s %s", err, reason, path)
		return IntegrityError{}
	}
	if ie.Reason != reason || ie.Path != path {
		t.Errorf("IntegrityError = {%s %q}, want {%s %q}", ie.Reason, ie.Path, reason, path)
	}
	return *ie
}

// V1
func TestVerifyValidSet(t *testing.T) {
	set, err := Verify(statictest.Default(), pub())
	if err != nil || set == nil {
		t.Fatalf("Verify = %v, %v; want a set", set, err)
	}
	f, ok := set.Lookup("assets/app.js")
	if !ok {
		t.Fatal("Lookup(assets/app.js) not found")
	}
	if !bytes.Equal(f.Identity.Bytes, statictest.AppJS) {
		t.Errorf("identity bytes = %q", f.Identity.Bytes)
	}
	if f.ContentType != "text/javascript; charset=utf-8" {
		t.Errorf("ContentType = %q", f.ContentType)
	}
	if f.Br == nil || !bytes.Equal(f.Br.Bytes, statictest.AppBr) {
		t.Errorf("Br = %v, want the .br bytes", f.Br)
	}
	if f.Gz == nil || !bytes.Equal(f.Gz.Bytes, statictest.AppGz) {
		t.Errorf("Gz = %v, want the .gz bytes", f.Gz)
	}
	if n := set.Len(); n != 2 {
		t.Errorf("Len = %d, want 2", n)
	}
	if _, ok := set.Lookup("assets/app.js.br"); ok {
		t.Error("a variant is a logical file")
	}
	idx, ok := set.Lookup("index.html")
	if !ok || idx.ContentType != "text/html; charset=utf-8" || idx.Br != nil || idx.Gz != nil {
		t.Errorf("index.html = %+v, %v", idx, ok)
	}
	etags := map[string]bool{f.Identity.ETag: true, f.Br.ETag: true, f.Gz.ETag: true}
	if len(etags) != 3 {
		t.Errorf("ETags not distinct: %q %q %q", f.Identity.ETag, f.Br.ETag, f.Gz.ETag)
	}
	for e := range etags {
		if len(e) != 24 || e[0] != '"' || e[23] != '"' {
			t.Errorf("ETag %q is not a 22-character strong validator", e)
		}
	}
	fsys := statictest.Default()
	if !bytes.Equal(set.Manifest, fsys[statictest.ManifestName].Data) || !bytes.Equal(set.Signature, fsys[statictest.SignatureName].Data) {
		t.Error("Manifest/Signature are not the verified bytes")
	}
}

// V2
func TestVerifyHashMismatch(t *testing.T) {
	fsys := statictest.Default()
	b := bytes.Clone(statictest.AppJS)
	b[3] ^= 1
	fsys["assets/app.js"] = &fstest.MapFile{Data: b, Mode: 0o644}
	set, err := Verify(fsys, pub())
	ie := wantIntegrity(t, set, err, "hash_mismatch", "assets/app.js")
	if ie.Expected == "" || ie.Actual == "" || ie.Expected == ie.Actual {
		t.Errorf("Expected %q Actual %q", ie.Expected, ie.Actual)
	}
	if got := err.Error(); got != "asset integrity check failed: hash_mismatch assets/app.js" {
		t.Errorf("Error() = %q", got)
	}
}

// V3
func TestVerifyMissingAndUnlisted(t *testing.T) {
	fsys := statictest.Default()
	delete(fsys, "assets/app.js.gz")
	set, err := Verify(fsys, pub())
	wantIntegrity(t, set, err, "missing_file", "assets/app.js.gz")

	fsys = statictest.Default()
	fsys["assets/x.js"] = &fstest.MapFile{Data: []byte("x"), Mode: 0o644}
	set, err = Verify(fsys, pub())
	wantIntegrity(t, set, err, "unlisted_file", "assets/x.js")
	if got := err.Error(); got != "asset integrity check failed: unlisted_file assets/x.js" {
		t.Errorf("Error() = %q", got)
	}
}

// V4
func TestVerifySignature(t *testing.T) {
	fsys := statictest.Default()
	m := bytes.Clone(fsys[statictest.ManifestName].Data)
	m[len(m)-2] = ' '
	fsys[statictest.ManifestName] = &fstest.MapFile{Data: m}
	set, err := Verify(fsys, pub())
	wantIntegrity(t, set, err, "bad_signature", "")

	set, err = Verify(statictest.Build(statictest.DefaultFiles(), statictest.Key2()), pub())
	wantIntegrity(t, set, err, "bad_signature", "")

	fsys = statictest.Default()
	fsys[statictest.SignatureName] = &fstest.MapFile{Data: fsys[statictest.SignatureName].Data[:63]}
	set, err = Verify(fsys, pub())
	wantIntegrity(t, set, err, "bad_signature", "")

	fsys = statictest.Default()
	delete(fsys, statictest.SignatureName)
	set, err = Verify(fsys, pub())
	wantIntegrity(t, set, err, "missing_signature", "")

	fsys = statictest.Default()
	delete(fsys, statictest.ManifestName)
	set, err = Verify(fsys, pub())
	wantIntegrity(t, set, err, "missing_manifest", "")
}

// V5
func TestVerifyKeys(t *testing.T) {
	set, err := Verify(statictest.Default(), nil)
	wantIntegrity(t, set, err, "no_public_key", "")

	keys := []ed25519.PublicKey{statictest.Public(statictest.Key2()), statictest.Public(statictest.Key())}
	if set, err := Verify(statictest.Default(), keys); err != nil || set == nil {
		t.Errorf("second key signed: Verify = %v, %v; want a set", set, err)
	}
}

// V6
func TestVerifyBadManifest(t *testing.T) {
	files := statictest.DefaultFiles()
	entries := func() []statictest.Entry { return statictest.Entries(files) }
	enc := func(es []statictest.Entry) []byte {
		return statictest.Encode(statictest.Manifest{Version: 1, Files: es})
	}
	short := base64.StdEncoding.EncodeToString(make([]byte, 47))
	cases := []struct {
		name     string
		manifest []byte
		files    map[string][]byte
		path     string
	}{
		{"unknown field", bytes.Replace(enc(entries()), []byte(`"path": "assets/app.js",`), []byte(`"path": "assets/app.js", "mode": 1,`), 1), nil, "assets/app.js"},
		{"version 2", statictest.Encode(statictest.Manifest{Version: 2, Files: entries()}), nil, ""},
		{"dot-dot", func() []byte {
			es := entries()
			es = append([]statictest.Entry{{Path: "../x", SHA384: es[0].SHA384, Size: 1}}, es...)
			return enc(es)
		}(), nil, "../x"},
		{"duplicate", func() []byte {
			es := entries()
			return enc(append(es[:1], es...))
		}(), nil, "assets/app.js"},
		{"unsorted", func() []byte {
			es := entries()
			es[0], es[1] = es[1], es[0]
			return enc(es)
		}(), nil, "assets/app.js"},
		{"orphan br", nil, map[string][]byte{"index.html": statictest.IndexHTML, "assets/lone.js.br": []byte("b")}, "assets/lone.js.br"},
		{"sha384 47 bytes", func() []byte {
			es := entries()
			es[3].SHA384 = short
			return enc(es)
		}(), nil, "index.html"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			fs := files
			if tc.files != nil {
				fs = tc.files
			}
			m := tc.manifest
			if m == nil {
				m = statictest.Encode(statictest.Manifest{Version: 1, Files: statictest.Entries(fs)})
			}
			set, err := Verify(statictest.BuildManifest(fs, m, statictest.Key()), pub())
			wantIntegrity(t, set, err, "bad_manifest", tc.path)
		})
	}
}

// V7
func TestVerifySizeBeforeHash(t *testing.T) {
	fsys := statictest.Default()
	fsys["assets/app.js"] = &fstest.MapFile{Data: append(bytes.Clone(statictest.AppJS), 'x')}
	set, err := Verify(fsys, pub())
	ie := wantIntegrity(t, set, err, "size_mismatch", "assets/app.js")
	want := len(statictest.AppJS)
	if ie.Expected != itoa(want) || ie.Actual != itoa(want+1) {
		t.Errorf("Expected %q Actual %q, want %d and %d", ie.Expected, ie.Actual, want, want+1)
	}
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	var b []byte
	for ; n > 0; n /= 10 {
		b = append([]byte{byte('0' + n%10)}, b...)
	}
	return string(b)
}

// V8
func TestPublicKeys(t *testing.T) {
	k1 := base64.StdEncoding.EncodeToString(statictest.Public(statictest.Key()))
	k2 := base64.StdEncoding.EncodeToString(statictest.Public(statictest.Key2()))
	old := releasePublicKeys
	t.Cleanup(func() { releasePublicKeys = old })
	for _, tc := range []struct {
		value   string
		n       int
		wantErr bool
	}{
		{"", 0, false},
		{k1, 1, false},
		{k1 + "," + k2, 2, false},
		{"!!", 0, true},
		{base64.StdEncoding.EncodeToString(make([]byte, 31)), 0, true},
	} {
		releasePublicKeys = tc.value
		keys, err := PublicKeys()
		if tc.wantErr {
			if err == nil {
				t.Errorf("PublicKeys(%q) = %d keys, want an error", tc.value, len(keys))
			}
			continue
		}
		if err != nil || len(keys) != tc.n {
			t.Errorf("PublicKeys(%q) = %d keys, %v; want %d", tc.value, len(keys), err, tc.n)
		}
	}
	releasePublicKeys = k1
	keys, err := PublicKeys()
	if err != nil || len(keys) != 1 || !keys[0].Equal(statictest.Public(statictest.Key())) {
		t.Errorf("PublicKeys = %v, %v; want the test key", keys, err)
	}
}

// faultFS wraps a MapFS and injects one fault.
type faultFS struct {
	fstest.MapFS
	readDirFails string                 // ReadDir of this directory fails
	statFails    string                 // Stat (and Open's Stat) of this file fails
	readFails    string                 // Read of this file fails
	modes        map[string]fs.FileMode // ReadDir reports these types
}

var errFault = errors.New("injected fault")

func (f faultFS) Open(name string) (fs.File, error) {
	if name == f.statFails {
		return nil, errFault
	}
	file, err := f.MapFS.Open(name)
	if err != nil {
		return nil, err
	}
	if name == f.readFails {
		return failingFile{file}, nil
	}
	return file, nil
}

func (f faultFS) Stat(name string) (fs.FileInfo, error) {
	if name == f.statFails {
		return nil, errFault
	}
	return f.MapFS.Stat(name)
}

func (f faultFS) ReadDir(name string) ([]fs.DirEntry, error) {
	if name == f.readDirFails {
		return nil, errFault
	}
	es, err := f.MapFS.ReadDir(name)
	if err != nil {
		return nil, err
	}
	for i, e := range es {
		p := e.Name()
		if name != "." {
			p = name + "/" + p
		}
		if m, ok := f.modes[p]; ok {
			es[i] = typedEntry{e, m}
		}
	}
	return es, nil
}

type typedEntry struct {
	fs.DirEntry
	mode fs.FileMode
}

func (e typedEntry) Type() fs.FileMode { return e.mode.Type() }
func (e typedEntry) IsDir() bool       { return e.mode.IsDir() }
func (e typedEntry) Info() (fs.FileInfo, error) {
	return typedInfo{name: e.Name(), mode: e.mode}, nil
}

type typedInfo struct {
	name string
	mode fs.FileMode
}

func (i typedInfo) Name() string       { return i.name }
func (i typedInfo) Size() int64        { return 0 }
func (i typedInfo) Mode() fs.FileMode  { return i.mode }
func (i typedInfo) ModTime() time.Time { return time.Time{} }
func (i typedInfo) IsDir() bool        { return i.mode.IsDir() }
func (i typedInfo) Sys() any           { return nil }

type failingFile struct{ fs.File }

func (failingFile) Read([]byte) (int, error) { return 0, errFault }

var _ io.Reader = failingFile{}

// V9
func TestVerifyTraversalAndEntries(t *testing.T) {
	base := statictest.Default
	cases := []struct {
		name         string
		fsys         fs.FS
		reason, path string
	}{
		{"readdir fails", faultFS{MapFS: base(), readDirFails: "assets"}, "walk_error", "assets"},
		{"stat fails", faultFS{MapFS: base(), statFails: "assets/app.js"}, "read_error", "assets/app.js"},
		{"read fails", faultFS{MapFS: base(), readFails: "assets/app.js"}, "read_error", "assets/app.js"},
		{"symlink", faultFS{MapFS: base(), modes: map[string]fs.FileMode{"assets/app.js": fs.ModeSymlink | 0o777}}, "unexpected_entry", "assets/app.js"},
		{"device", faultFS{MapFS: base(), modes: map[string]fs.FileMode{"assets/app.js.gz": fs.ModeDevice | 0o600}}, "unexpected_entry", "assets/app.js.gz"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			set, err := Verify(tc.fsys, pub())
			wantIntegrity(t, set, err, tc.reason, tc.path)
		})
	}
}

func TestContentTypes(t *testing.T) {
	for path, want := range map[string]string{
		"a.html": "text/html; charset=utf-8", "a.js": "text/javascript; charset=utf-8",
		"a.mjs": "text/javascript; charset=utf-8", "a.css": "text/css; charset=utf-8",
		"a.json": "application/json", "a.map": "application/json", "a.svg": "image/svg+xml",
		"a.woff2": "font/woff2", "a.wasm": "application/wasm", "a.png": "image/png",
		"a.ico": "image/x-icon", "a.txt": "text/plain; charset=utf-8", "a.bin": "application/octet-stream",
		"noext": "application/octet-stream",
	} {
		if got := contentType(path); got != want {
			t.Errorf("contentType(%q) = %q, want %q", path, got, want)
		}
	}
}
