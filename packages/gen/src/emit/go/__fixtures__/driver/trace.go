package main

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"sync/atomic"
	"time"

	sdk "honey.test/driver/sdk"
)

// trace is what a scripted run prints beside the observed (compiled.ts Trace).
type trace struct {
	Calls       []callTrace     `json:"calls"`
	Hooks       []hookTrace     `json:"hooks"`
	Log         []logTrace      `json:"log"`
	AuthExpired int             `json:"authExpired"`
	Transport   *transportTrace `json:"transport,omitempty"`
}

// callTrace is one call: its time, its error when it has one, a safe-mode SDKResult's summary, and
// what a stream call recorded.
type callTrace struct {
	ElapsedMs int64        `json:"elapsedMs"`
	Error     *goError     `json:"error,omitempty"`
	Result    *resultTrace `json:"result,omitempty"`
	Stream    *streamTrace `json:"stream,omitempty"`
}

// resultTrace is a safe-mode SDKResult the method returned without an error.
type resultTrace struct {
	OK       bool `json:"ok"`
	Status   int  `json:"status"`
	Data     bool `json:"data"`
	Response bool `json:"response"`
}

// goError is a call's error as Go sees it: its types down the Unwrap chain, its text, where it came
// from, the sentinels it matches, its status, the error keys and sentinels asked about and a
// refused path param.
type goError struct {
	Type      string          `json:"type"`
	Chain     []string        `json:"chain"`
	Text      string          `json:"text"`
	Via       string          `json:"via"`
	Canceled  bool            `json:"canceled"`
	Deadline  bool            `json:"deadline"`
	TooLarge  bool            `json:"tooLarge"`
	Status    *int            `json:"status,omitempty"`
	Keys      map[string]bool `json:"keys,omitempty"`
	Sentinels map[string]bool `json:"sentinels,omitempty"`
	PathParam *pathParamTrace `json:"pathParam,omitempty"`
}

// pathParamTrace is a refused path param, as *sdk.PathParamError holds it.
type pathParamTrace struct {
	Name    string `json:"name"`
	Value   string `json:"value"`
	Missing bool   `json:"missing"`
}

// hookTrace is one hook run: its phase, its index among that phase's hooks, the call it ran for,
// and what its context held.
type hookTrace struct {
	Phase         string   `json:"phase"`
	Index         int      `json:"index"`
	Call          int      `json:"call"`
	Method        string   `json:"method,omitempty"`
	URL           string   `json:"url,omitempty"`
	Path          string   `json:"path,omitempty"`
	Status        int      `json:"status,omitempty"`
	IsRetry       bool     `json:"isRetry"`
	Selector      string   `json:"selector"`
	IsStale       bool     `json:"isStale"`
	InvalidatedBy []string `json:"invalidatedBy"`
}

// logTrace is one OnLog entry, its error as text.
type logTrace struct {
	Level     string `json:"level"`
	Event     string `json:"event"`
	Operation string `json:"operation"`
	Status    *int   `json:"status,omitempty"`
	Error     string `json:"error,omitempty"`
}

type transportTrace struct {
	RoundTrips    int64 `json:"roundTrips"`
	CheckRedirect int64 `json:"checkRedirect"`
}

// transportCounts is what the caller HTTPClient counts while it runs.
type transportCounts struct {
	roundTrips    atomic.Int64
	checkRedirect atomic.Int64
}

// recorder collects a run's trace; the SDK may call hooks, OnLog and OnAuthExpired off the call's
// goroutine, so every write holds mu.
type recorder struct {
	mu        sync.Mutex
	current   int
	calls     []callTrace
	hooks     []hookTrace
	log       []logTrace
	expired   int
	transport *transportCounts
}

// begin marks call i as the one hooks run for.
func (r *recorder) begin(i int) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.current = i
}

// called records the call that just ended after elapsed, asking its error what d asks about.
func (r *recorder) called(elapsed time.Duration, o outcome, d directives) {
	entry := callTrace{ElapsedMs: elapsed.Milliseconds(), Result: o.result, Stream: o.stream}
	if o.err != nil {
		entry.Error = goErrorOf(o.err, o.via, d)
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	r.calls = append(r.calls, entry)
}

// goErrorOf is err as the trace records it, asked about d's error keys and sentinels.
func goErrorOf(err error, via string, d directives) *goError {
	e := &goError{
		Type:     fmt.Sprintf("%T", err),
		Text:     err.Error(),
		Via:      via,
		Canceled: errors.Is(err, context.Canceled),
		Deadline: errors.Is(err, context.DeadlineExceeded),
		TooLarge: errors.Is(err, sdk.ErrResponseTooLarge),
	}
	for at := err; at != nil; at = errors.Unwrap(at) {
		e.Chain = append(e.Chain, fmt.Sprintf("%T", at))
	}
	var apiErr sdk.APIError
	if errors.As(err, &apiErr) {
		status := apiErr.Status()
		e.Status = &status
	}
	var pp *sdk.PathParamError
	if errors.As(err, &pp) {
		e.PathParam = &pathParamTrace{Name: pp.Name, Value: pp.Value, Missing: pp.Missing}
	}
	if len(d.IsKeys) > 0 {
		e.Keys = map[string]bool{}
		for _, key := range d.IsKeys {
			e.Keys[key] = errors.Is(err, sdk.ErrorKey(key))
		}
	}
	if len(d.IsErrors) > 0 {
		e.Sentinels = map[string]bool{}
		for _, name := range d.IsErrors {
			sentinel, _ := sentinelOf(name)
			e.Sentinels[name] = errors.Is(err, sentinel)
		}
	}
	return e
}

// hook records one hook run for the current call.
func (r *recorder) hook(h hookTrace) {
	r.mu.Lock()
	defer r.mu.Unlock()
	h.Call = r.current
	if h.InvalidatedBy == nil {
		h.InvalidatedBy = []string{}
	}
	r.hooks = append(r.hooks, h)
}

// requestHooks are the scripted OnRequest hooks, each recording what it saw before acting.
func (r *recorder) requestHooks(entries []requestHook) []func(*sdk.RequestContext) error {
	hooks := make([]func(*sdk.RequestContext) error, 0, len(entries))
	for i, entry := range entries {
		hooks = append(hooks, func(rc *sdk.RequestContext) error {
			r.hook(hookTrace{Phase: "request", Index: i, Method: rc.Method, URL: rc.URL, Path: rc.Path, IsRetry: rc.IsRetry,
				Selector: rc.Selector, IsStale: rc.IsStale, InvalidatedBy: rc.InvalidatedBy})
			if entry.SetHeader != nil {
				rc.Headers.Set(entry.SetHeader[0], entry.SetHeader[1])
			}
			if entry.Fail != "" {
				return errors.New(entry.Fail)
			}
			return nil
		})
	}
	return hooks
}

// responseHooks are the scripted OnResponse hooks, each recording what it saw before acting.
func (r *recorder) responseHooks(entries []responseHook) []func(*sdk.ResponseContext) error {
	hooks := make([]func(*sdk.ResponseContext) error, 0, len(entries))
	for i, entry := range entries {
		hooks = append(hooks, func(rc *sdk.ResponseContext) error {
			r.hook(hookTrace{Phase: "response", Index: i, Status: rc.Status, IsRetry: rc.IsRetry,
				Selector: rc.Selector, IsStale: rc.IsStale, InvalidatedBy: rc.InvalidatedBy})
			if entry.Body != nil {
				rc.Body = []byte(*entry.Body)
			}
			if entry.Fail != "" {
				return errors.New(entry.Fail)
			}
			return nil
		})
	}
	return hooks
}

// refresher is OnAuthExpired answering tokens in order, then failing.
func (r *recorder) refresher(tokens []string) func(context.Context) (string, error) {
	return func(context.Context) (string, error) {
		r.mu.Lock()
		defer r.mu.Unlock()
		r.expired++
		if r.expired > len(tokens) {
			return "", errors.New("driver: no token left")
		}
		return tokens[r.expired-1], nil
	}
}

// logger is OnLog, recording each entry.
func (r *recorder) logger() func(sdk.LogEntry) {
	return func(e sdk.LogEntry) {
		entry := logTrace{Level: e.Level, Event: e.Event, Operation: e.Operation, Status: e.Status}
		if e.Err != nil {
			entry.Error = e.Err.Error()
		}
		r.mu.Lock()
		defer r.mu.Unlock()
		r.log = append(r.log, entry)
	}
}

// trace is what was recorded, every list present even when empty.
func (r *recorder) trace() trace {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := trace{Calls: r.calls, Hooks: r.hooks, Log: r.log, AuthExpired: r.expired}
	if out.Calls == nil {
		out.Calls = []callTrace{}
	}
	if out.Hooks == nil {
		out.Hooks = []hookTrace{}
	}
	if out.Log == nil {
		out.Log = []logTrace{}
	}
	if r.transport != nil {
		out.Transport = &transportTrace{RoundTrips: r.transport.roundTrips.Load(), CheckRedirect: r.transport.checkRedirect.Load()}
	}
	return out
}
