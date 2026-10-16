package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"reflect"
	"time"

	sdk "honey.test/driver/sdk"
)

// stallAfter bounds every stream call: one that has not ended by then fails the run, so a
// regressed parser or a script that never ends fails the test instead of hanging it.
const stallAfter = 10 * time.Second

// streamTrace is what a stream call recorded beside its observed (emit/shared/__fixtures__/protocol.ts StreamTrace).
type streamTrace struct {
	Yields     int               `json:"yields"`
	Retry      []int             `json:"retry,omitempty"`
	Headers    map[string]string `json:"headers,omitempty"`
	Handlers   []handlerTrace    `json:"handlers,omitempty"`
	ClosedBy   *closeTrace       `json:"closedBy,omitempty"`
	CloseError string            `json:"closeError,omitempty"`
	Realtime   *realtimeTrace    `json:"realtime,omitempty"`
}

// streamCall is a stream call ready to go: its job, ctx, method and arguments, and the typed
// response headers WithHeadersInto fills (nil without them).
type streamCall struct {
	j      job
	ctx    context.Context
	method reflect.Value
	args   []reflect.Value
	target any
}

// streamed is what a stream call observed and the outcome it records, or why the run fails.
type streamed struct {
	seen any
	o    outcome
	err  error
}

// streamRefusal names what of j's stream controls the driver cannot express; nil when it can.
func streamRefusal(j job) error {
	c, d := j.c, j.d
	kind := ""
	if j.p.Stream != nil {
		kind = *j.p.Stream
	}
	controls := c.LastEventID != "" || c.ReconnectToken != "" || c.Send != nil || c.Take != nil
	scripted := d.Protocols != nil || d.Realtime != nil || d.WS != nil
	switch {
	case kind == "" && (controls || scripted):
		return errors.New("stream controls (lastEventId, reconnectToken, send, take; scripted protocols, realtime, ws) on an operation that does not stream")
	case kind == "":
		return nil
	case c.Raw:
		return fmt.Errorf("raw: true on a %s operation, which has no single response to read", kind)
	case c.LastEventID != "" && kind == "ws":
		return errors.New("lastEventId on a WebSocket operation: only SSE and realtime resume by event id")
	case (c.ReconnectToken != "" || c.Send != nil || d.Protocols != nil) && kind == "sse":
		return errors.New("reconnectToken, send or protocols on an SSE operation: only WebSocket and realtime take them")
	case d.WS != nil && kind != "ws":
		return fmt.Errorf("a ws script on a %s operation", kind)
	case d.Realtime != nil && kind != "realtime":
		return fmt.Errorf("a realtime script on a %s operation", kind)
	case kind == "realtime" && c.Take == nil:
		return errors.New("a realtime call without take: the connection never ends by itself")
	}
	return nil
}

// streamOpts sets an <Op>Opts' stream fields by their fixed names: the call's resume cursor, the
// scripted protocols and the realtime reconnect knobs.
func streamOpts(opts reflect.Value, j job) error {
	rt := j.d.Realtime
	if rt == nil {
		rt = &realtimeScript{}
	}
	fields := []struct {
		name  string
		value any
		set   bool
	}{
		{"LastEventID", j.c.LastEventID, j.c.LastEventID != ""},
		{"ReconnectToken", j.c.ReconnectToken, j.c.ReconnectToken != ""},
		{"Protocols", j.d.Protocols, j.d.Protocols != nil},
		{"MaxReconnectAttempts", rt.MaxReconnectAttempts, rt.MaxReconnectAttempts != nil},
		{"ReconnectDelayMs", rt.ReconnectDelayMs, rt.ReconnectDelayMs != nil},
	}
	for _, f := range fields {
		if !f.set {
			continue
		}
		raw, _ := json.Marshal(f.value)
		if err := setField(opts, f.name, raw); err != nil {
			return err
		}
	}
	return nil
}

// stream drives s on its own goroutine, giving up after stallAfter.
func (r *runner) stream(s streamCall) (any, outcome, error) {
	done := make(chan streamed, 1)
	go func() {
		switch *s.j.p.Stream {
		case "sse":
			done <- driveSSE(s)
		case "ws":
			done <- driveSocket(s)
		default:
			done <- driveRealtime(s)
		}
	}()
	select {
	case out := <-done:
		return out.seen, out.o, out.err
	case <-time.After(stallAfter):
		return nil, outcome{}, fmt.Errorf("stream stalled: no end within %s", stallAfter)
	}
}

// driveSSE ranges the method's iter.Seq2[SSEEvent[T], error] through a reflect.MakeFunc yield,
// breaking after take events (absent: to the end). A yielded error is recorded and the yield
// carries on, so an iterator that does not end after its error shows in yields.
func driveSSE(s streamCall) streamed {
	seq := s.method.CallSlice(s.args)[0]
	st := &streamTrace{}
	events := []any{}
	var failed, broken error
	yield := reflect.MakeFunc(seq.Type().In(0), func(in []reflect.Value) []reflect.Value {
		st.Yields++
		if err := errOf(in[1]); err != nil {
			failed = firstOf(failed, err)
			return []reflect.Value{reflect.ValueOf(true)}
		}
		event, err := eventOf(in[0])
		if err != nil {
			broken = err
			return []reflect.Value{reflect.ValueOf(false)}
		}
		events = append(events, event)
		st.Retry = append(st.Retry, int(in[0].FieldByName("Retry").Int()))
		return []reflect.Value{reflect.ValueOf(s.j.c.Take == nil || len(events) < *s.j.c.Take)}
	})
	seq.Call([]reflect.Value{yield})
	if broken != nil {
		return streamed{err: broken}
	}
	if s.target != nil {
		headers, err := headersOf(s.target, s.j.p.ResponseHeaders.Fields)
		if err != nil {
			return streamed{err: err}
		}
		st.Headers = headers
	}
	return streamed{seen: observedStream("events", events, failed), o: outcome{err: failed, via: "stream", stream: st}}
}

// eventOf is an SSEEvent[T] as the grid observes it: data as the JSON of Data (a string for
// SSEEvent[string]), event and id only when set.
func eventOf(ev reflect.Value) (map[string]any, error) {
	data, err := json.Marshal(ev.FieldByName("Data").Interface())
	if err != nil {
		return nil, fmt.Errorf("event data: %w", err)
	}
	out := map[string]any{"data": json.RawMessage(data)}
	if name := ev.FieldByName("Event").String(); name != "" {
		out["event"] = name
	}
	if id := ev.FieldByName("ID").String(); id != "" {
		out["id"] = id
	}
	return out, nil
}

// observedStream is a stream's Observed: kind ("events" or "frames") holding items, unless it
// failed before any item with an error status (error) or a lapsed deadline (timeout).
func observedStream(kind string, items []any, failed error) any {
	var ce *sdk.ClientError
	switch {
	case len(items) > 0 || failed == nil:
	case errors.As(failed, &ce):
		return errorOf(ce)
	case errors.Is(failed, context.DeadlineExceeded):
		return map[string]any{"kind": "timeout"}
	}
	return map[string]any{"kind": kind, kind: items}
}

// openFailed is a stream method that failed before any stream existed: an error status or a
// timeout as the grid observes it, else null.
func openFailed(err error) streamed {
	o := outcome{err: err, via: "return"}
	if !gridError(err) {
		return streamed{o: o}
	}
	return streamed{seen: observedStream("frames", nil, err), o: o}
}

// invoke calls v's method name with args, each converted to the parameter type it fills.
func invoke(v reflect.Value, name string, args ...any) ([]reflect.Value, error) {
	m := v.MethodByName(name)
	if !m.IsValid() || m.Type().NumIn() != len(args) {
		return nil, fmt.Errorf("%s has no method %s of %d parameters", v.Type(), name, len(args))
	}
	in := make([]reflect.Value, len(args))
	for i, arg := range args {
		want := m.Type().In(i)
		switch at := reflect.ValueOf(arg); {
		case arg == nil:
			in[i] = reflect.Zero(want)
		case at.Type().AssignableTo(want):
			in[i] = at
		case at.Type().ConvertibleTo(want):
			in[i] = at.Convert(want)
		default:
			return nil, fmt.Errorf("%s.%s takes a %s, not a %s", v.Type(), name, want, at.Type())
		}
	}
	return m.Call(in), nil
}

// errOf is v as an error; nil for a nil one.
func errOf(v reflect.Value) error {
	err, _ := v.Interface().(error)
	return err
}

// firstOf is first unless it is nil, then next: a stream fails with its first error.
func firstOf(first, next error) error {
	if first != nil {
		return first
	}
	return next
}

// sentinelOf is the SDK sentinel isErrors may name, by its Go name.
func sentinelOf(name string) (error, bool) {
	switch name {
	case "ErrSSEEventTooLarge":
		return sdk.ErrSSEEventTooLarge, true
	case "ErrSSELineTooLong":
		return sdk.ErrSSELineTooLong, true
	}
	return nil, false
}
