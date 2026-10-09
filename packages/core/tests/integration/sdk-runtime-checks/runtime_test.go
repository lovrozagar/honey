// Behavior checks for the generated Go runtime (white-box, package sdk); copied into the
// generated SDK and run with `go test -race` by ../polyglot-runtime.test.ts.

package sdk

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

/* H62 + token kept + single refresh: a JSON body is resent on the auth retry,
 * the new token is reused by the next call, a Reader body is not retried. */
func TestAuthRetryResendsBodyAndKeepsToken(t *testing.T) {
	var mu sync.Mutex
	bodies := []string{}
	auths := []string{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		mu.Lock()
		bodies = append(bodies, string(b))
		auths = append(auths, r.Header.Get("Authorization"))
		mu.Unlock()
		if r.Header.Get("Authorization") != "Bearer fresh" {
			w.WriteHeader(401)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"id":"u1","name":"A","email":"e"}`))
	}))
	defer srv.Close()
	var refreshes int32
	c := NewClient(Config{BaseURL: srv.URL, BearerToken: "stale", OnAuthExpired: func(context.Context) (string, error) {
		atomic.AddInt32(&refreshes, 1)
		return "fresh", nil
	}})
	if _, err := c.CreateUser(context.Background(), UserCreate{Name: "A", Email: "e"}, nil); err != nil {
		t.Fatal(err)
	}
	if bodies[0] == "" || bodies[1] != bodies[0] {
		t.Fatalf("retry body %q vs %q", bodies[1], bodies[0])
	}
	if _, err := c.GetUser(context.Background(), "u1", nil); err != nil {
		t.Fatal(err)
	}
	if auths[len(auths)-1] != "Bearer fresh" || atomic.LoadInt32(&refreshes) != 1 {
		t.Fatalf("token not kept: %v refreshes=%d", auths, refreshes)
	}
	/* a Reader body is not retried after the token goes stale again */
	c2 := NewClient(Config{BaseURL: srv.URL, BearerToken: "stale", OnAuthExpired: func(context.Context) (string, error) { return "fresh", nil }})
	before := len(bodies)
	if _, err := c2.UploadBlob(context.Background(), strings.NewReader("data"), nil); err == nil {
		t.Fatal("expected the 401")
	}
	if len(bodies) != before+1 {
		t.Fatalf("reader body was retried: %d requests", len(bodies)-before)
	}
}

/* Config.Timeout bounds a regular call; it does not cut an SSE stream. */
func TestTimeoutBoundsCallsNotStreams(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/slow" {
			time.Sleep(300 * time.Millisecond)
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"ms":1}`))
			return
		}
		w.Header().Set("Content-Type", "text/event-stream")
		f := w.(http.Flusher)
		for i := 0; i < 3; i++ {
			fmt.Fprintf(w, "data: %d\n\n", i)
			f.Flush()
			time.Sleep(120 * time.Millisecond)
		}
	}))
	defer srv.Close()
	c := NewClient(Config{BaseURL: srv.URL, Timeout: 100 * time.Millisecond})
	if _, err := c.Slow(context.Background(), nil); err == nil || !strings.Contains(err.Error(), "timed out") {
		t.Fatalf("expected timeout, got %v", err)
	}
	n := 0
	for _, err := range c.StreamEvents(context.Background(), nil) {
		if err != nil {
			t.Fatal(err)
		}
		n++
	}
	if n != 3 {
		t.Fatalf("stream cut after %d events", n)
	}
}

/* The default client does not follow a redirect to another host. */
func TestNoCrossHostRedirect(t *testing.T) {
	var leaked atomic.Bool
	other := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("X-Api-Key") != "" {
			leaked.Store(true)
		}
	}))
	defer other.Close()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, other.URL+"/users/u1", http.StatusTemporaryRedirect)
	}))
	defer srv.Close()
	c := NewClient(Config{BaseURL: srv.URL, Headers: map[string]string{"X-Api-Key": "k"}})
	_, err := c.GetUser(context.Background(), "u1", nil)
	var apiErr APIError
	if !errors.As(err, &apiErr) || apiErr.Status() != 307 {
		t.Fatalf("expected a 307 error, got %v", err)
	}
	if leaked.Load() {
		t.Fatal("custom header followed the redirect")
	}
}

/* Path params "", ".", ".." are refused before sending; the base path is kept. */
func TestPathParamsAndBasePath(t *testing.T) {
	var got string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got = r.URL.EscapedPath()
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"id":"x","name":"n","email":"e"}`))
	}))
	defer srv.Close()
	c := NewClient(Config{BaseURL: srv.URL + "/api"})
	for _, bad := range []string{"", ".", ".."} {
		var pe *PathParamError
		if _, err := c.GetUser(context.Background(), bad, nil); !errors.As(err, &pe) {
			t.Fatalf("%q: expected PathParamError, got %v", bad, err)
		}
	}
	if _, err := c.GetUser(context.Background(), "a b/c", nil); err != nil {
		t.Fatal(err)
	}
	if got != "/api/users/a%20b%2Fc" {
		t.Fatalf("path %q", got)
	}
}

/* Error messages are capped and stripped of control characters. */
func TestErrorMessageSanitized(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(500)
		_, _ = w.Write([]byte("\x1b]0;pwned\x07" + strings.Repeat("x", 2000)))
	}))
	defer srv.Close()
	_, err := NewClient(Config{BaseURL: srv.URL}).GetUser(context.Background(), "u", nil)
	if err == nil || strings.ContainsRune(err.Error(), 0x1b) || len(err.Error()) > 700 {
		t.Fatalf("unsanitized: %d %q", len(err.Error()), err.Error()[:40])
	}
}

/* Invalidation: a param-less mutation keeps templated targets as patterns. */
func TestInvalidationPatterns(t *testing.T) {
	tr := NewStaleTracker(&InvalidationConfig{StaleTime: 60000})
	tr.MarkStale([]string{"GET /users/{user-id}"}, nil, "POST /x")
	if !tr.IsStale("GET", "/users/42") {
		t.Fatal("pattern target dropped")
	}
	if p, _ := interpolatePath("/ops/{id}:cancel", map[string]string{"id": "7"}); p != "/ops/7:cancel" {
		t.Fatalf("got %q", p)
	}
	tr.MarkStale([]string{"GET /ops/1:cancel"}, nil, "POST /y")
	if tr.IsStale("GET", "/ops/2:cancel") {
		t.Fatal("a literal colon was treated as a placeholder")
	}
}

/* A lookup scans the pattern keys of its method, not every entry; eviction keeps LRU order. */
func TestStaleLookupScale(t *testing.T) {
	tr := NewStaleTracker(&InvalidationConfig{StaleTime: 60000, StaleMaxEntries: 100000})
	keys := make([]string, 0, 20000)
	for i := 0; i < 20000; i++ {
		keys = append(keys, fmt.Sprintf("GET /items/%d", i))
	}
	tr.MarkStale(keys, nil, "POST /items")
	tr.MarkStale([]string{"GET /users/{id}"}, nil, "PUT /users")
	start := time.Now()
	for i := 0; i < 2000; i++ {
		tr.LookupStale(fmt.Sprintf("GET /users/%d", i), fmt.Sprintf("/users/%d", i), "GET", time.Now())
	}
	if d := time.Since(start); d > 500*time.Millisecond {
		t.Fatalf("2000 lookups over 20000 entries took %s", d)
	}
	if by, ok := tr.LookupStale("GET /users/9", "/users/9", "GET", time.Now()); !ok || len(by) != 1 || by[0] != "PUT /users" {
		t.Fatalf("pattern lookup: %v %v", by, ok)
	}
	meta := tr.BuildRequestMeta("GET /users/9", "/users/9", "GET")
	tr.ClearStale("GET /users/9", "/users/9", "GET", meta.SeqSnapshot)
	if tr.IsStale("GET", "/users/9") || !tr.IsStale("GET", "/items/3") {
		t.Fatal("clear dropped the wrong keys")
	}

	small := NewStaleTracker(&InvalidationConfig{StaleTime: 60000, StaleMaxEntries: 4})
	for _, k := range []string{"GET /a", "GET /b", "GET /c", "GET /d"} {
		small.MarkStale([]string{k}, nil, "POST /x")
	}
	small.MarkStale([]string{"GET /a"}, nil, "POST /x") /* touch: /a is now the newest */
	small.MarkStale([]string{"GET /e"}, nil, "POST /x") /* over capacity: keep the newest half */
	if !small.IsStale("GET", "/a") || !small.IsStale("GET", "/e") || small.IsStale("GET", "/b") {
		t.Fatal("eviction did not keep the most recently touched keys")
	}
}

type failTransport struct{ connects atomic.Int32 }

func (f *failTransport) Name() string        { return "fail" }
func (f *failTransport) Kind() TransportKind { return TransportWs }
func (f *failTransport) Connect(ctx context.Context, _ string, _ *TransportOpts) (TransportConn, error) {
	if f.connects.Add(1) == 1 {
		return &dyingConn{}, nil
	}
	return nil, errors.New("down")
}

type dyingConn struct{}

func (d *dyingConn) Recv(context.Context) (any, error)   { return nil, errors.New("dropped") }
func (d *dyingConn) Send(context.Context, any) error     { return nil }
func (d *dyingConn) Close() error                        { return nil }
func (d *dyingConn) Kind() TransportKind                 { return TransportWs }

/* H57: a dead server ends in Errors() after bounded attempts, not a spin. */
func TestRealtimeGivesUp(t *testing.T) {
	ft := &failTransport{}
	rc := NewResumableConnection("http://x", []Transport{ft}, &TransportOpts{MaxReconnectAttempts: 3, ReconnectDelayMs: 1})
	if err := rc.Connect(context.Background()); err != nil {
		t.Fatal(err)
	}
	select {
	case err := <-rc.Errors():
		if err == nil {
			t.Fatal("nil error")
		}
	case <-time.After(5 * time.Second):
		t.Fatal("no terminal error")
	}
	if n := ft.connects.Load(); n != 4 {
		t.Fatalf("connect attempts = %d, want 1 + 3", n)
	}
	_ = rc.Close()
	/* H59: Connect after Close and double Close never panic */
	if err := rc.Connect(context.Background()); !errors.Is(err, ErrConnectionClosed) {
		t.Fatalf("got %v", err)
	}
	_ = rc.Close()
}

/* H58: the SSE transport's stream outlives the Connect ctx. */
func TestSseTransportOutlivesConnectCtx(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		w.(http.Flusher).Flush()
		time.Sleep(100 * time.Millisecond)
		fmt.Fprint(w, "data: {\"n\":1}\n\n")
		w.(http.Flusher).Flush()
	}))
	defer srv.Close()
	ctx, cancel := context.WithCancel(context.Background())
	conn, err := (&SseTransport{}).Connect(ctx, srv.URL, &TransportOpts{})
	if err != nil {
		t.Fatal(err)
	}
	cancel()
	v, err := conn.Recv(context.Background())
	if err != nil {
		t.Fatalf("stream died with the connect ctx: %v", err)
	}
	if m, ok := v.(map[string]any); !ok || m["n"] != float64(1) {
		t.Fatalf("got %v", v)
	}
	_ = conn.Close()
}

/* H59: Close racing a delivering read loop never panics (run with -race). */
func TestRealtimeCloseRace(t *testing.T) {
	for i := 0; i < 50; i++ {
		rc := NewResumableConnection("http://x", []Transport{&chattyTransport{}}, nil)
		if err := rc.Connect(context.Background()); err != nil {
			t.Fatal(err)
		}
		go func() {
			for range rc.Events() {
			}
		}()
		time.Sleep(time.Millisecond)
		_ = rc.Close()
	}
}

type chattyTransport struct{}

func (c *chattyTransport) Name() string        { return "chatty" }
func (c *chattyTransport) Kind() TransportKind { return TransportWs }
func (c *chattyTransport) Connect(context.Context, string, *TransportOpts) (TransportConn, error) {
	return &chattyConn{}, nil
}

type chattyConn struct{}

func (c *chattyConn) Recv(ctx context.Context) (any, error) {
	select {
	case <-ctx.Done():
		return nil, ctx.Err()
	default:
		return 1, nil
	}
}
func (c *chattyConn) Send(context.Context, any) error { return nil }
func (c *chattyConn) Close() error                    { return nil }
func (c *chattyConn) Kind() TransportKind             { return TransportWs }

var _ = bytes.NewReader
