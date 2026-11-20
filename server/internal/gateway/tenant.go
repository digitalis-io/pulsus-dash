package gateway

import "github.com/digitalis-io/pulsus-dash/server/internal/gateway/api"

// upstreamError maps a PulsusDB failure to the response of §4.4.
func upstreamError(err error) (int, api.ErrorBody, string) {
	_ = err
	return 0, api.ErrorBody{}, ""
}
