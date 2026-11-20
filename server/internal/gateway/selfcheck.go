package gateway

import (
	"context"
	"io"
	"log/slog"
	"net/http"
)

// selfCheckHeaders are the document headers a proxy in front of the BFF must not strip or
// rewrite, in the order they are checked.
var selfCheckHeaders = [][2]string{
	{"Cross-Origin-Opener-Policy", "same-origin"},
	{"Cross-Origin-Embedder-Policy", "require-corp"},
	{"Content-Security-Policy", documentCSP},
}

// SelfCheck makes one request to the configured public URL and logs whether the document headers
// arrive intact (T19-002): with assets, GET <publicURL>/ with Accept: text/html; API-only, GET
// <publicURL>/healthz. It never retries, never logs the URL, and returns when ctx is cancelled.
// The caller runs it in its own goroutine after the listener opens; it never fails start-up.
func SelfCheck(ctx context.Context, publicURL string, assets bool, client *http.Client, log *slog.Logger) {
	const msg = "public_url_self_check"
	target := publicURL + "/healthz"
	if assets {
		target = publicURL + "/"
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, target, nil)
	if err != nil {
		log.WarnContext(ctx, msg, "result", "unreachable")
		return
	}
	if assets {
		req.Header.Set("Accept", "text/html")
	}
	resp, err := client.Do(req)
	if err != nil {
		// The error text carries the URL; only the outcome is logged.
		log.WarnContext(ctx, msg, "result", "unreachable")
		return
	}
	defer func() {
		_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 1<<20))
		_ = resp.Body.Close()
	}()
	if resp.StatusCode != http.StatusOK {
		log.WarnContext(ctx, msg, "result", "status", "status", resp.StatusCode)
		return
	}
	if assets {
		for _, h := range selfCheckHeaders {
			if resp.Header.Get(h[0]) != h[1] {
				log.WarnContext(ctx, msg, "result", "headers_stripped", "header", h[0])
				return
			}
		}
	}
	log.InfoContext(ctx, msg, "result", "ok")
}
