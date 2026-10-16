package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"sync/atomic"
	"time"

	sdk "honey.test/driver/sdk"
)

// script is the envelope's optional script, decoded strictly (compiled.ts Script names each member).
type script struct {
	Config        *scriptConfig `json:"config"`
	OnAuthExpired *struct {
		Tokens []string `json:"tokens"`
	} `json:"onAuthExpired"`
	Hooks *struct {
		Request  []requestHook  `json:"request"`
		Response []responseHook `json:"response"`
	} `json:"hooks"`
	Log          bool          `json:"log"`
	LogDurations bool          `json:"logDurations"`
	Calls        []*directives `json:"calls"`
}

// scriptConfig sets Config fields a grid Setup has no member for.
type scriptConfig struct {
	AuthHeaderName   *string `json:"authHeaderName"`
	AuthHeaderPrefix *string `json:"authHeaderPrefix"`
	Invalidation     *struct {
		StaleTimeMs         *int64 `json:"staleTimeMs"`
		StaleMaxEntries     int    `json:"staleMaxEntries"`
		MaxSourcesPerTarget int    `json:"maxSourcesPerTarget"`
	} `json:"invalidation"`
	MaxResponseBytes *int64 `json:"maxResponseBytes"`
	HTTPClient       bool   `json:"httpClient"`
}

// requestHook is one OnRequest hook: it sets a header, then fails when told to.
type requestHook struct {
	SetHeader []string `json:"setHeader"`
	Fail      string   `json:"fail"`
}

// responseHook is one OnResponse hook: it replaces the body, then fails when told to.
type responseHook struct {
	Body *string `json:"body"`
	Fail string  `json:"fail"`
}

// directives is one call's script entry; the zero value directs nothing.
type directives struct {
	Cancel         json.RawMessage `json:"cancel"`
	CtxTimeoutMs   *int64          `json:"ctxTimeoutMs"`
	SleepMs        int64           `json:"sleepMs"`
	OneShotBody    bool            `json:"oneShotBody"`
	IdempotencyKey *string         `json:"idempotencyKey"`
	IsKeys         []string        `json:"isKeys"`
	IsErrors       []string        `json:"isErrors"`
	Protocols      []string        `json:"protocols"`
	Envelope       bool            `json:"envelope"`
	Realtime       *realtimeScript `json:"realtime"`
	WS             *wsScript       `json:"ws"`

	cancelBefore bool
	cancelAfter  *time.Duration
}

// scriptOf decodes raw strictly and checks what JSON cannot; nil when the envelope has no script.
func scriptOf(raw json.RawMessage, calls int) (*script, error) {
	if len(raw) == 0 {
		return nil, nil
	}
	var s script
	if err := strict(raw, &s); err != nil {
		return nil, err
	}
	if len(s.Calls) > calls {
		return nil, fmt.Errorf("%d calls scripted for a cell of %d", len(s.Calls), calls)
	}
	for i, d := range s.Calls {
		if d == nil {
			continue
		}
		if err := d.parseCancel(); err != nil {
			return nil, fmt.Errorf("call %d: %w", i, err)
		}
		if err := d.checkStream(); err != nil {
			return nil, fmt.Errorf("call %d: %w", i, err)
		}
	}
	if s.LogDurations && !s.Log {
		return nil, errors.New("logDurations needs log")
	}
	if c := s.Config; c != nil && c.Invalidation != nil && c.Invalidation.StaleTimeMs == nil {
		return nil, errors.New("config.invalidation needs staleTimeMs")
	}
	if s.Hooks != nil {
		for i, hook := range s.Hooks.Request {
			if hook.SetHeader != nil && len(hook.SetHeader) != 2 {
				return nil, fmt.Errorf("hooks.request %d: setHeader is [name, value]", i)
			}
		}
	}
	return &s, nil
}

// parseCancel reads cancel: "before", or {afterMs}.
func (d *directives) parseCancel() error {
	if len(d.Cancel) == 0 {
		return nil
	}
	if string(d.Cancel) == `"before"` {
		d.cancelBefore = true
		return nil
	}
	var after struct {
		AfterMs *int64 `json:"afterMs"`
	}
	if err := strict(d.Cancel, &after); err != nil || after.AfterMs == nil {
		return fmt.Errorf("cancel %s is neither \"before\" nor {afterMs}", d.Cancel)
	}
	at := time.Duration(*after.AfterMs) * time.Millisecond
	d.cancelAfter = &at
	return nil
}

// directivesOf is call i's script entry; none without a script or an entry.
func (s *script) directivesOf(i int) directives {
	if s == nil || i >= len(s.Calls) || s.Calls[i] == nil {
		return directives{}
	}
	return *s.Calls[i]
}

// apply sets the script's client config and installs its recorders on cfg: the hooks always (one
// no-op recording hook per phase whose list is absent), OnAuthExpired and OnLog (with each entry's
// duration under logDurations) when asked.
func (s *script) apply(cfg *sdk.Config, rec *recorder) {
	if s == nil {
		return
	}
	if s.Config != nil {
		s.Config.apply(cfg, rec)
	}
	if s.OnAuthExpired != nil {
		cfg.OnAuthExpired = rec.refresher(s.OnAuthExpired.Tokens)
	}
	request, response := []requestHook{{}}, []responseHook{{}}
	if s.Hooks != nil && s.Hooks.Request != nil {
		request = s.Hooks.Request
	}
	if s.Hooks != nil && s.Hooks.Response != nil {
		response = s.Hooks.Response
	}
	cfg.OnRequest = rec.requestHooks(request)
	cfg.OnResponse = rec.responseHooks(response)
	if s.Log {
		cfg.OnLog = rec.logger(s.LogDurations)
	}
}

// apply sets each given field on cfg.
func (c *scriptConfig) apply(cfg *sdk.Config, rec *recorder) {
	if c.AuthHeaderName != nil {
		cfg.AuthHeaderName = *c.AuthHeaderName
	}
	if c.AuthHeaderPrefix != nil {
		cfg.AuthHeaderPrefix = *c.AuthHeaderPrefix
	}
	if inv := c.Invalidation; inv != nil {
		cfg.Invalidation = &sdk.InvalidationConfig{
			StaleTime:           *inv.StaleTimeMs,
			StaleMaxEntries:     inv.StaleMaxEntries,
			MaxSourcesPerTarget: inv.MaxSourcesPerTarget,
		}
	}
	if c.MaxResponseBytes != nil {
		cfg.MaxResponseBytes = *c.MaxResponseBytes
	}
	if c.HTTPClient {
		cfg.HTTPClient = rec.countingClient()
	}
}

// ctxOf is the call's ctx under its directives (a caller deadline, a cancel before or during the
// call), and the release to defer.
func (d directives) ctxOf() (context.Context, context.CancelFunc) {
	ctx, cancel := context.WithCancel(context.Background())
	release := cancel
	if d.CtxTimeoutMs != nil {
		bounded, stop := context.WithTimeout(ctx, time.Duration(*d.CtxTimeoutMs)*time.Millisecond)
		ctx, release = bounded, func() { stop(); cancel() }
	}
	if d.cancelBefore {
		cancel()
	}
	if d.cancelAfter != nil {
		timer := time.AfterFunc(*d.cancelAfter, cancel)
		inner := release
		release = func() { timer.Stop(); inner() }
	}
	return ctx, release
}

// countingTransport counts the round trips it carries.
type countingTransport struct {
	next http.RoundTripper
	n    *atomic.Int64
}

func (t countingTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	t.n.Add(1)
	return t.next.RoundTrip(req)
}

// countingClient is a caller HTTPClient: http.DefaultTransport under a counter, and a
// CheckRedirect that counts and allows; its counts land in the trace's transport.
func (r *recorder) countingClient() *http.Client {
	counts := &transportCounts{}
	r.transport = counts
	return &http.Client{
		Transport: countingTransport{next: http.DefaultTransport, n: &counts.roundTrips},
		CheckRedirect: func(*http.Request, []*http.Request) error {
			counts.checkRedirect.Add(1)
			return nil
		},
	}
}
