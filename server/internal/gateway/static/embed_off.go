//go:build !embedassets

package static

import "io/fs"

// Embedded returns nil: this binary was built without -tags embedassets (make server-build).
func Embedded() fs.FS { return nil }
