//go:build itest

package pulsusdb

import (
	"os"
	"testing"
	"time"

	"github.com/digitalis-io/pulsus-dash/server/internal/core"
)

// contractLexer is the logql-lexer subtest (plan #121 §3.4, §4.5): runLexer against the
// deployment, recording into DASH_CONTRACT_RECORD_DIR when it is set. It prints nothing but
// runLexer's error, which holds only case ids and reason codes.
func contractLexer(t *testing.T, c *Client, rc *core.RequestCtx) {
	ctx := ctxWithin(t, 30*time.Second)
	b := rc.Tenant.Binding
	cred, err := c.credential(ctx, rc)
	if err != nil {
		t.Fatalf("logql-lexer: credential: %v", errProbeRequest)
	}
	secrets := probeSecrets(b.DatasourceURL, b.ScopeOrgID, cred)
	date := time.Now().UTC().Format(time.DateOnly)
	if err := runLexer(ctx, c, rc, lexerCases, secrets, date, os.Getenv("DASH_CONTRACT_RECORD_DIR")); err != nil {
		t.Fatalf("logql-lexer: %v", err)
	}
}
