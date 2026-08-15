/* ============================================================================
 * Honey SDK — Go end-to-end example
 *
 * Assumes ./sdk/ was generated via generateGoSDK(spec, { modulePath: "example.com/mock-sdk" })
 * and is reachable via a `replace example.com/mock-sdk => ./sdk` directive.
 * This file is DOCUMENTATION — not a compile target. Types referenced below
 * exist only after codegen.
 *
 * Demonstrates the cross-lang parity surface:
 *   1. Client init + config                   9.  Per-call headers merge
 *   2. Typed operation call                  10.  Invalidation + IsStale
 *   3. Typed error hierarchy                 11.  SSE iteration
 *   4. Declared error payload (err.Data)     12.  WebSocket bidi + close
 *   5. OnAuthExpired + 1x 401 retry          13.  Realtime + Transport iface
 *   6. OnRequest / OnResponse hooks          14.  Streaming upload
 *   7. OnLog lifecycle                       15.  x-idempotency-key
 *   8. Per-call timeout override             16.  context.Context cancel
 * ========================================================================== */

package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"time"

	sdk "example.com/mock-sdk"
)

func main() {
	baseURL := os.Getenv("BASE_URL")
	if baseURL == "" {
		baseURL = "http://127.0.0.1:8080"
	}
	ctx := context.Background()
	runExample(ctx, baseURL)
	runHookDemo()
}

func runExample(ctx context.Context, baseURL string) {
	/* §1 + §5 + §6 + §7 + §10: Config — mechanism not policy. SDK supplies
	 * the hook slots; consumer code picks strategies. */
	client := sdk.NewClient(sdk.Config{
		BaseURL: baseURL,
		Headers: map[string]string{"Authorization": "Bearer expired-token"},
		/* §5: exactly one retry on 401. Return "" to let the 401 propagate. */
		OnAuthExpired: func(ctx context.Context) (string, error) {
			return "valid-token", nil
		},
		/* §6: hook chains are []func; declaration order = execution order. */
		OnRequest: []func(*sdk.RequestContext) error{
			func(c *sdk.RequestContext) error { c.Headers.Set("X-Trace-Id", "trace-123"); return nil },
			func(c *sdk.RequestContext) error { c.Headers.Set("X-App", "example"); return nil },
		},
		OnResponse: []func(*sdk.ResponseContext) error{
			func(c *sdk.ResponseContext) error {
				if c.Status >= 500 {
					fmt.Println("5xx:", c.Status)
				}
				return nil
			},
		},
		/* §7: single pluggable sink — NOT a logger framework. */
		OnLog: func(e sdk.LogEntry) {
			fmt.Println(e.Event, e.Operation, e.DurationMs, e.Status)
		},
		Invalidation: sdk.InvalidationConfig{StaleTime: 5 * time.Second},
		Timeout:      10 * time.Second,
	})

	/* §2 + §3 + §4: typed call + errors.As for typed error hierarchy. Each
	 * *FooError carries Status(), Body, and typed Data fields. */
	user, err := client.CreateUser(ctx, sdk.UserCreate{Name: "Alice", Email: "a@b.com"}, nil)
	if err != nil {
		var bre *sdk.BadRequestError
		var ue *sdk.UnauthorizedError
		var nfe *sdk.NotFoundError
		var rle *sdk.RateLimitError
		var ise *sdk.InternalServerError
		switch {
		case errors.As(err, &bre):
			fmt.Println("400 data:", bre.Data, "body:", string(bre.Body))
		case errors.As(err, &ue):
			fmt.Println("401")
		case errors.As(err, &nfe):
			fmt.Println("404")
		case errors.As(err, &rle):
			fmt.Println("429 — backoff per consumer policy")
		case errors.As(err, &ise):
			fmt.Println("500")
		default:
			fmt.Println("unknown:", err)
		}
	} else {
		fmt.Println(user.Id, user.Name)
	}

	/* §8: per-call timeout override via opts. Config is a default; opts wins. */
	_, err = client.Slow(ctx, &sdk.SlowOpts{Ms: 200, Timeout: 50 * time.Millisecond})
	if err != nil {
		fmt.Println("aborted:", err)
	}

	/* §9: per-call headers merge over config headers; per-call wins per key. */
	_, _ = client.GetUser(ctx, "u1", &sdk.GetUserOpts{
		Headers: map[string]string{"X-Both": "call-wins"},
	})

	/* §10: mutation invalidates matching GET paths. Consumer polls IsStale. */
	_, _ = client.UpdateUser(ctx, "u1", sdk.UserUpdate{Name: "Alice2"}, nil)
	fmt.Println("users/u1 stale?", client.IsStale("GET", "/users/u1"))

	/* §11: SSE — stream iteration. Server-sent text/event-stream. */
	stream, err := client.StreamEvents(ctx, nil)
	if err == nil {
		for ev := range stream.Events() {
			fmt.Println("sse event:", ev)
			break
		}
		stream.Close()
	}

	/* §12: WebSocket — bidi channel. ws.Send / ws.Recv / ws.Close. */
	ws, err := client.ConnectWs(ctx, nil)
	if err == nil {
		_ = ws.Send("hello")
		msg, _ := ws.Recv()
		fmt.Println("ws recv:", msg)
		_ = ws.Close(1000, "done")
	}

	/* §13: x-realtime ResumableConnection — Transport interface + auto
	 * fallback chain + proven-transport memoization (hidden, always on). */
	rc, err := client.ConnectRealtime(ctx, &sdk.ConnectRealtimeOpts{
		Transports:           []sdk.Transport{&tickTransport{}},
		MaxReconnectAttempts: 5,
		ReconnectDelayMs:     100,
	})
	if err == nil {
		for ev := range rc.Events() {
			fmt.Println("rt event:", ev)
			break
		}
		rc.Close()
	}

	/* §14: streaming upload — io.Reader. No buffering; SDK pipes the reader
	 * straight into the HTTP request body. */
	const total = 1024 * 1024
	buf := make([]byte, total)
	for i := range buf {
		buf[i] = byte(i & 0xff)
	}
	sum := sha256.Sum256(buf)
	uploaded, err := client.UploadBlob(ctx, bytes.NewReader(buf), nil)
	if err == nil {
		fmt.Println("uploaded:", uploaded.Size, uploaded.Hash, "expected:", hex.EncodeToString(sum[:]))
	}

	/* §15: x-idempotency-key — auto UUID when caller omits; opts override;
	 * Headers["Idempotency-Key"] wins over opts key. */
	auto, _ := client.IdempotentCreate(ctx, nil)
	explicit, _ := client.IdempotentCreate(ctx, &sdk.IdempotentCreateOpts{IdempotencyKey: "user-supplied-123"})
	viaHeader, _ := client.IdempotentCreate(ctx, &sdk.IdempotentCreateOpts{
		Headers: map[string]string{"Idempotency-Key": "header-wins-456"},
	})
	fmt.Println(auto.IdempotencyKey, explicit.IdempotencyKey, viaHeader.IdempotencyKey)

	/* §16: context.Context is the native cancellation primitive. Cancellation
	 * propagates to the HTTP client + SSE + WS + ResumableConnection. */
	cancelCtx, cancel := context.WithTimeout(ctx, 25*time.Millisecond)
	defer cancel()
	_, err = client.Slow(cancelCtx, &sdk.SlowOpts{Ms: 500})
	if err != nil {
		fmt.Println("cancelled:", err)
	}
}

/* tickTransport is a minimal custom Transport impl for §13 demo. Real consumer
 * transports wrap gorilla/websocket, nhooyr.io/websocket, SSE, etc. */
type tickTransport struct{}

func (t *tickTransport) Name() string           { return "tick" }
func (t *tickTransport) Kind() sdk.TransportKind { return sdk.TransportKindWs }

func (t *tickTransport) Connect(_ context.Context, _ string, _ sdk.TransportOpts) (sdk.TransportConn, error) {
	return &tickConn{}, nil
}

type tickConn struct{ sent bool }

func (c *tickConn) Recv(ctx context.Context) (interface{}, error) {
	if c.sent {
		<-ctx.Done()
		return nil, ctx.Err()
	}
	c.sent = true
	return map[string]string{"kind": "tick"}, nil
}
func (c *tickConn) Send(_ interface{}) error { return nil }
func (c *tickConn) Close() error              { return nil }

/* runHookDemo spins an httptest.Server in-process to show OnRequest/OnResponse
 * hooks mutating + observing live traffic without needing the mock server. */
func runHookDemo() {
	var captured http.Header
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		captured = r.Header.Clone()
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(200)
		_, _ = io.WriteString(w, `{"id":"u1","name":"Alice","email":"a@b.com"}`)
	}))
	defer srv.Close()

	client := sdk.NewClient(sdk.Config{
		BaseURL: srv.URL,
		OnRequest: []func(*sdk.RequestContext) error{
			func(c *sdk.RequestContext) error { c.Headers.Set("X-Hook-1", "a"); return nil },
			func(c *sdk.RequestContext) error { c.Headers.Set("X-Hook-2", "b"); return nil },
		},
	})
	_, _ = client.GetUser(context.Background(), "u1", nil)
	fmt.Println("hook demo:", captured.Get("X-Hook-1"), captured.Get("X-Hook-2"))
}
