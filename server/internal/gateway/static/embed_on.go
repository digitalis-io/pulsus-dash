//go:build embedassets

package static

import (
	"embed"
	"io/fs"
)

// distFS is the packed client build (make assets-pack writes dist/).
//
//go:embed all:dist
var distFS embed.FS

// Embedded returns the embedded asset tree (make build).
func Embedded() fs.FS {
	sub, err := fs.Sub(distFS, "dist")
	if err != nil {
		// fs.Sub fails only for an invalid directory name; "dist" is valid.
		return nil
	}
	return sub
}
