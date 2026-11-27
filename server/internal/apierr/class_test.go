package apierr_test

import (
	"context"
	"errors"
	"fmt"
	"reflect"
	"testing"

	"github.com/digitalis-io/pulsus-dash/server/internal/apierr"
	"github.com/digitalis-io/pulsus-dash/server/internal/arrowwire"
	"github.com/digitalis-io/pulsus-dash/server/internal/pulsusdb"
)

func ptr[T any](v T) *T { return &v }

// TestClassify (plan #68 D1 §3.4): every row of the mapping, for the envelope (Class) and the
// error/1 row (arrowwire.ErrorFrom).
func TestClassify(t *testing.T) {
	type row = arrowwire.ErrorRow
	narrow := ptr("narrow")
	for _, c := range []struct {
		name string
		err  error
		want apierr.Class
		wire row
	}{
		{"query invalid", &pulsusdb.Error{Kind: pulsusdb.KindQueryInvalid, Message: "1:4: parse error", Position: &pulsusdb.Position{Offset: 3}, QueryID: "q1"},
			apierr.Class{Kind: apierr.BadQuery, Status: 400, Code: apierr.CodeInvalid, Message: "1:4: parse error", Position: ptr(3), QueryID: "q1"},
			row{Code: 0, HTTPStatus: 400, Message: "1:4: parse error", Position: ptr(uint32(3))}},
		{"query invalid, no position", &pulsusdb.Error{Kind: pulsusdb.KindQueryInvalid, Message: "bad"},
			apierr.Class{Kind: apierr.BadQuery, Status: 400, Code: apierr.CodeInvalid, Message: "bad"},
			row{Code: 0, HTTPStatus: 400, Message: "bad"}},
		{"virtual", pulsusdb.ReservedError("query", "ALERTS"),
			apierr.Class{Kind: apierr.Virtual, Status: 400, Code: apierr.CodeVirtualUnsupported, Message: pulsusdb.ReservedError("query", "ALERTS").Message,
				Field: "query", Reserved: "ALERTS"},
			row{Code: 0, HTTPStatus: 400, Message: pulsusdb.ReservedError("query", "ALERTS").Message}},
		{"too broad", &pulsusdb.Error{Kind: pulsusdb.KindTooBroad, Message: "too many series", QueryID: "q2"},
			apierr.Class{Kind: apierr.TooBroad, Status: 422, Code: apierr.CodeTooBroad, Message: "too many series", Suggestion: apierr.SuggestNarrow, QueryID: "q2"},
			row{Code: 1, HTTPStatus: 422, Message: "too many series", Suggestion: narrow}},
		{"scope denied", &pulsusdb.Error{Kind: pulsusdb.KindScopeDenied, QueryID: "q3"},
			apierr.Class{Kind: apierr.ScopeDenied, Status: 403, Code: apierr.CodeScopeDenied, Message: "data scopes are not supported yet"},
			row{Code: 3, HTTPStatus: 403, Message: "data scopes are not supported yet"}},
		{"rate limited", &pulsusdb.Error{Kind: pulsusdb.KindRateLimited, RetryAfter: "7", QueryID: "q4"},
			apierr.Class{Kind: apierr.RateLimited, Status: 429, Code: apierr.CodeBudgetExhausted, Message: "PulsusDB is rate limiting this tenant",
				Reason: "upstream_rate_limited", RetryAfter: "7", QueryID: "q4"},
			row{Code: 7, HTTPStatus: 429, Message: "PulsusDB is rate limiting this tenant", RetryAfterMs: ptr(uint32(7000))}},
		{"rate limited, no retry", &pulsusdb.Error{Kind: pulsusdb.KindRateLimited},
			apierr.Class{Kind: apierr.RateLimited, Status: 429, Code: apierr.CodeBudgetExhausted, Message: "PulsusDB is rate limiting this tenant",
				Reason: "upstream_rate_limited"},
			row{Code: 7, HTTPStatus: 429, Message: "PulsusDB is rate limiting this tenant"}},
		{"busy", &pulsusdb.Error{Kind: pulsusdb.KindBusy, QueryID: "q5"},
			apierr.Class{Kind: apierr.Busy, Status: 429, Code: apierr.CodeBudgetExhausted, Message: "too many queries in flight for this tenant",
				Reason: "tenant_concurrency", RetryAfter: "1"},
			row{Code: 7, HTTPStatus: 429, Message: "too many queries in flight for this tenant", RetryAfterMs: ptr(uint32(1000))}},
		{"timeout", &pulsusdb.Error{Kind: pulsusdb.KindTimeout, QueryID: "q6"},
			apierr.Class{Kind: apierr.Timeout, Status: 504, Code: apierr.CodeUnavailable, Message: "the query timed out", Reason: "upstream_timeout",
				Suggestion: apierr.SuggestNarrow, QueryID: "q6"},
			row{Code: 5, HTTPStatus: 504, Message: "the query timed out", Suggestion: narrow}},
		{"deadline", fmt.Errorf("read: %w", context.DeadlineExceeded),
			apierr.Class{Kind: apierr.Timeout, Status: 504, Code: apierr.CodeUnavailable, Message: "the query timed out", Reason: "upstream_timeout",
				Suggestion: apierr.SuggestNarrow},
			row{Code: 5, HTTPStatus: 504, Message: "the query timed out", Suggestion: narrow}},
		{"unreachable", &pulsusdb.Error{Kind: pulsusdb.KindUnreachable},
			apierr.Class{Kind: apierr.Unavailable, Status: 502, Code: apierr.CodeUnavailable, Message: "PulsusDB could not be reached", Reason: "upstream_unreachable"},
			row{Code: 4, HTTPStatus: 502, Message: "PulsusDB could not be reached"}},
		{"unavailable", &pulsusdb.Error{Kind: pulsusdb.KindUnavailable, QueryID: "q7"},
			apierr.Class{Kind: apierr.Unavailable, Status: 502, Code: apierr.CodeUnavailable, Message: "PulsusDB is unavailable", Reason: "upstream_unavailable", QueryID: "q7"},
			row{Code: 4, HTTPStatus: 502, Message: "PulsusDB is unavailable"}},
		{"unauthorised", &pulsusdb.Error{Kind: pulsusdb.KindUnauthorised},
			apierr.Class{Kind: apierr.Unavailable, Status: 502, Code: apierr.CodeUnavailable, Message: "PulsusDB refused the datasource credentials", Reason: "upstream_unauthorised"},
			row{Code: 4, HTTPStatus: 502, Message: "PulsusDB refused the datasource credentials"}},
		{"protocol", &pulsusdb.Error{Kind: pulsusdb.KindProtocol},
			apierr.Class{Kind: apierr.Unavailable, Status: 502, Code: apierr.CodeUnavailable, Message: "PulsusDB returned an unexpected response", Reason: "upstream_error"},
			row{Code: 4, HTTPStatus: 502, Message: "PulsusDB returned an unexpected response"}},
		{"config", &pulsusdb.Error{Kind: pulsusdb.KindConfig},
			apierr.Class{Kind: apierr.Config, Status: 503, Code: apierr.CodeUnavailable, Message: "the datasource is misconfigured", Reason: "datasource_config"},
			row{Code: 4, HTTPStatus: 503, Message: "the datasource is misconfigured"}},
		{"cancelled", fmt.Errorf("read: %w", context.Canceled),
			apierr.Class{Kind: apierr.Cancelled, Code: apierr.CodeInternal, Message: "cancelled"},
			row{Code: 6, Message: "cancelled"}},
		{"internal", errors.New("boom"),
			apierr.Class{Kind: apierr.Internal, Status: 500, Code: apierr.CodeInternal, Message: "internal error"},
			row{Code: 8, HTTPStatus: 500, Message: "internal error"}},
	} {
		got := apierr.Classify(c.err)
		if !reflect.DeepEqual(got, c.want) {
			t.Errorf("%s: class %+v, want %+v", c.name, got, c.want)
		}
		if w := arrowwire.ErrorFrom(got); !reflect.DeepEqual(w, c.wire) {
			t.Errorf("%s: error/1 %+v, want %+v", c.name, w, c.wire)
		}
	}
}
