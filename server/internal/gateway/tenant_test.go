package gateway

import (
	"context"
	"encoding/json"
	"errors"
	"testing"

	"github.com/digitalis-io/pulsus-dash/server/internal/pulsusdb"
)

// unit:upstream-errors (§4.4): one pulsusdb.Error per kind maps to its row exactly.
func TestUpstreamErrors(t *testing.T) {
	for _, c := range []struct {
		err        error
		status     int
		body       string
		retryAfter string
	}{
		{&pulsusdb.Error{Kind: pulsusdb.KindQueryInvalid, Status: 400, Message: "1:4: parse error: x", Position: &pulsusdb.Position{Offset: 3}, QueryID: "q1"},
			400, `{"code":"invalid","message":"1:4: parse error: x","hint":{"position":{"offset":3}},"query_id":"q1","fields":[{"pointer":"/query","message_key":"query.invalid"}]}`, ""},
		{&pulsusdb.Error{Kind: pulsusdb.KindQueryInvalid, Status: 400, Message: "unclosed left parenthesis"},
			400, `{"code":"invalid","message":"unclosed left parenthesis","fields":[{"pointer":"/query","message_key":"query.invalid"}]}`, ""},
		{&pulsusdb.Error{Kind: pulsusdb.KindTooBroad, Status: 422, Message: "too many", QueryID: "q2"},
			422, `{"code":"too_broad","message":"too many","hint":{"action":"narrow"},"query_id":"q2"}`, ""},
		{&pulsusdb.Error{Kind: pulsusdb.KindRateLimited, Status: 429, RetryAfter: "7"},
			429, `{"code":"budget_exhausted","message":"PulsusDB is rate limiting this tenant","hint":{"reason":"upstream_rate_limited"}}`, "7"},
		{&pulsusdb.Error{Kind: pulsusdb.KindRateLimited, Status: 429},
			429, `{"code":"budget_exhausted","message":"PulsusDB is rate limiting this tenant","hint":{"reason":"upstream_rate_limited"}}`, ""},
		{&pulsusdb.Error{Kind: pulsusdb.KindBusy},
			429, `{"code":"budget_exhausted","message":"too many queries in flight for this tenant","hint":{"reason":"tenant_concurrency"}}`, "1"},
		{&pulsusdb.Error{Kind: pulsusdb.KindTimeout, Status: 504, QueryID: "q3"},
			504, `{"code":"unavailable","message":"the query timed out","hint":{"action":"narrow","reason":"upstream_timeout"},"query_id":"q3"}`, ""},
		{&pulsusdb.Error{Kind: pulsusdb.KindUnreachable},
			502, `{"code":"unavailable","message":"PulsusDB could not be reached","hint":{"reason":"upstream_unreachable"}}`, ""},
		{&pulsusdb.Error{Kind: pulsusdb.KindUnavailable, Status: 503},
			502, `{"code":"unavailable","message":"PulsusDB is unavailable","hint":{"reason":"upstream_unavailable"}}`, ""},
		{&pulsusdb.Error{Kind: pulsusdb.KindUnauthorised, Status: 401},
			502, `{"code":"unavailable","message":"PulsusDB refused the datasource credentials","hint":{"reason":"upstream_unauthorised"}}`, ""},
		{&pulsusdb.Error{Kind: pulsusdb.KindProtocol, Status: 500},
			502, `{"code":"unavailable","message":"PulsusDB returned an unexpected response","hint":{"reason":"upstream_error"}}`, ""},
		{&pulsusdb.Error{Kind: pulsusdb.KindConfig},
			503, `{"code":"unavailable","message":"the datasource is misconfigured","hint":{"reason":"datasource_config"}}`, ""},
		{&pulsusdb.Error{Kind: pulsusdb.KindScopeDenied},
			403, `{"code":"scope_denied","message":"data scopes are not supported yet"}`, ""},
		{&pulsusdb.Error{Kind: pulsusdb.KindVirtual, Field: "match/1", Reserved: "ALERTS", Message: "ALERTS is a reserved Pulsus Dash name and is not supported yet (it may appear only inside a string)"},
			400, `{"code":"virtual_unsupported","message":"ALERTS is a reserved Pulsus Dash name and is not supported yet (it may appear only inside a string)","hint":{"reserved":"ALERTS"},"fields":[{"pointer":"/match/1","message_key":"query.reserved"}]}`, ""},
		{context.DeadlineExceeded,
			504, `{"code":"unavailable","message":"the query timed out","hint":{"action":"narrow","reason":"upstream_timeout"}}`, ""},
		{errors.New("other"),
			500, `{"code":"internal","message":"internal error"}`, ""},
	} {
		status, body, ra := upstreamError(c.err)
		b, _ := json.Marshal(body)
		var got, want any
		_ = json.Unmarshal(b, &got)
		if err := json.Unmarshal([]byte(c.body), &want); err != nil {
			t.Fatal(err)
		}
		g, _ := json.Marshal(got)
		w, _ := json.Marshal(want)
		if status != c.status || string(g) != string(w) || ra != c.retryAfter {
			t.Errorf("%v:\n got %d %s Retry-After %q\nwant %d %s Retry-After %q", c.err, status, g, ra, c.status, w, c.retryAfter)
		}
	}
}
