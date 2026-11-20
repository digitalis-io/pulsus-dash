// Package migrations embeds the goose SQL migrations (T11-012): append-only, expand-only, no Down
// sections.
package migrations

import "embed"

// FS holds every migration file, named NNNNN_name.sql.
//
//go:embed *.sql
var FS embed.FS
