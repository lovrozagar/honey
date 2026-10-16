package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"reflect"
	"strings"
	"sync"
)

// wsScript drives a WebSocket past the grid's send and take: handlers registered with On, more
// messages sent, a read limit, and the close the call ends with (default 1000, no reason).
type wsScript struct {
	On        bool        `json:"on"`
	Send      []wsMessage `json:"send"`
	ReadLimit *int64      `json:"readLimit"`
	Close     *closeTrace `json:"close"`
}

// wsMessage is one scripted Send: a JSON value (decoded, so Send marshals it), text, or that many
// bytes i & 0xff.
type wsMessage struct {
	JSON  json.RawMessage `json:"json"`
	Text  *string         `json:"text"`
	Bytes *int            `json:"bytes"`
}

// realtimeScript sets the realtime <Op>Opts reconnect fields a grid Call has no member for.
type realtimeScript struct {
	MaxReconnectAttempts *int `json:"maxReconnectAttempts"`
	ReconnectDelayMs     *int `json:"reconnectDelayMs"`
}

// handlerTrace is one On handler run: its event and the data it got, as text.
type handlerTrace struct {
	Event string `json:"event"`
	Data  string `json:"data"`
}

// closeTrace is a close frame's code and reason.
type closeTrace struct {
	Code   int    `json:"code"`
	Reason string `json:"reason"`
}

// checkStream refuses what JSON cannot: a ws message naming no or several kinds, an unknown sentinel.
func (d *directives) checkStream() error {
	for _, name := range d.IsErrors {
		if _, ok := sentinelOf(name); !ok {
			return fmt.Errorf("isErrors: %q is not a sentinel the driver knows (ErrSSEEventTooLarge, ErrSSELineTooLong)", name)
		}
	}
	for i, m := range d.wsMessages() {
		kinds := 0
		for _, set := range []bool{m.JSON != nil, m.Text != nil, m.Bytes != nil} {
			if set {
				kinds++
			}
		}
		if kinds != 1 {
			return fmt.Errorf("ws.send %d names %d of json, text and bytes; give one", i, kinds)
		}
	}
	return nil
}

// wsMessages is the scripted Sends; none without a ws script.
func (d *directives) wsMessages() []wsMessage {
	if d.WS == nil {
		return nil
	}
	return d.WS.Send
}

// payload is m as the value Send takes.
func (m wsMessage) payload() (any, error) {
	switch {
	case m.Text != nil:
		return *m.Text, nil
	case m.Bytes != nil:
		data := make([]byte, *m.Bytes)
		for i := range data {
			data[i] = byte(i)
		}
		return data, nil
	}
	var value any
	err := json.Unmarshal(m.JSON, &value)
	return value, err
}

// handlers records the On handlers' runs in firing order; the SDK may fire them off the call's goroutine.
type handlers struct {
	mu   sync.Mutex
	runs []handlerTrace
}

// on is the handler recording event.
func (h *handlers) on(event string) func([]byte) {
	return func(data []byte) {
		h.mu.Lock()
		defer h.mu.Unlock()
		h.runs = append(h.runs, handlerTrace{Event: event, Data: string(data)})
	}
}

// driveSocket drives the method's *TypedWebSocket: the scripted handlers and read limit, the
// grid's send as text frames then the scripted ones, Read take times (absent: until it fails),
// then Close. A Read ending on a close frame is the stream's end, recorded as closedBy; any other
// failure is the call's error. Every handler run is traced, those Close fires included.
func driveSocket(s streamCall) streamed {
	if t := s.method.Type(); !returnsPointer(t, "TypedWebSocket") {
		return streamed{err: fmt.Errorf("the WebSocket method returns %s, not (*TypedWebSocket, error)", outTypes(t))}
	}
	out := s.method.CallSlice(s.args)
	if err := errOf(out[1]); err != nil {
		return openFailed(err)
	}
	ws, script, h := out[0], s.j.d.WS, &handlers{}
	if script == nil {
		script = &wsScript{}
	}
	steps := [][]any{}
	if script.On {
		for _, event := range []string{"message", "close", "error"} {
			steps = append(steps, []any{"On", event, h.on(event)})
		}
	}
	if script.ReadLimit != nil {
		steps = append(steps, []any{"SetReadLimit", *script.ReadLimit})
	}
	for _, text := range s.j.c.Send {
		steps = append(steps, []any{"Send", s.ctx, text})
	}
	failed, err := socketSteps(ws, steps, script.Send, s)
	if err != nil {
		return streamed{err: err}
	}
	st := &streamTrace{}
	frames := []any{}
	if failed == nil {
		frames, failed, err = readFrames(ws, s, st)
		if err != nil {
			return streamed{err: err}
		}
	}
	end := closeTrace{Code: 1000}
	if script.Close != nil {
		end = *script.Close
	}
	closed, err := invoke(ws, "Close", end.Code, end.Reason)
	if err != nil {
		return streamed{err: err}
	}
	if closeErr := errOf(closed[0]); closeErr != nil {
		st.CloseError = closeErr.Error()
	}
	st.Handlers = h.runs
	return streamed{seen: observedStream("frames", frames, failed), o: outcome{err: failed, via: "stream", stream: st}}
}

// socketSteps calls each step's method on ws, then Sends each scripted message; the first Send
// error, or a failure of the run.
func socketSteps(ws reflect.Value, steps [][]any, messages []wsMessage, s streamCall) (error, error) {
	for _, m := range messages {
		value, err := m.payload()
		if err != nil {
			return nil, fmt.Errorf("ws.send: %w", err)
		}
		steps = append(steps, []any{"Send", s.ctx, value})
	}
	for _, step := range steps {
		out, err := invoke(ws, step[0].(string), step[1:]...)
		if err != nil {
			return nil, err
		}
		if len(out) == 1 && errOf(out[0]) != nil {
			return errOf(out[0]), nil
		}
	}
	return nil, nil
}

// readFrames Reads take frames (absent: until a Read fails), each as its JSON when it is JSON and
// its text otherwise; a close frame is recorded on st, any other Read error returned.
func readFrames(ws reflect.Value, s streamCall, st *streamTrace) ([]any, error, error) {
	frames := []any{}
	for s.j.c.Take == nil || len(frames) < *s.j.c.Take {
		out, err := invoke(ws, "Read", s.ctx)
		if err != nil {
			return nil, nil, err
		}
		if failed := errOf(out[1]); failed != nil {
			st.ClosedBy = closeErrorOf(failed)
			if st.ClosedBy == nil {
				return frames, failed, nil
			}
			return frames, nil, nil
		}
		st.Yields++
		data := out[0].Bytes()
		if json.Valid(data) {
			frames = append(frames, json.RawMessage(data))
		} else {
			frames = append(frames, string(data))
		}
	}
	return frames, nil, nil
}

// closeErrorOf is the github.com/coder/websocket CloseError in err's chain, read by reflection so
// the driver builds against an SDK without the library; nil when there is none.
func closeErrorOf(err error) *closeTrace {
	if err == nil {
		return nil
	}
	v := reflect.ValueOf(err)
	if v.Kind() == reflect.Pointer && !v.IsNil() {
		v = v.Elem()
	}
	if v.Type().Name() == "CloseError" && strings.HasSuffix(v.Type().PkgPath(), "coder/websocket") {
		return &closeTrace{Code: int(v.FieldByName("Code").Int()), Reason: v.FieldByName("Reason").String()}
	}
	if joined, ok := err.(interface{ Unwrap() []error }); ok {
		for _, inner := range joined.Unwrap() {
			if found := closeErrorOf(inner); found != nil {
				return found
			}
		}
	}
	return closeErrorOf(errors.Unwrap(err))
}
