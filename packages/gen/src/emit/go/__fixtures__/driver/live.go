package main

import (
	"errors"
	"reflect"

	sdk "honey.test/driver/sdk"
)

// realtimeTrace is a realtime connection read after Close (Close waits for the read loop, so the
// cursor is settled): its resume cursor, the transport kind that last opened (null for none), and
// every value Errors() delivered.
type realtimeTrace struct {
	Cursor struct {
		LastEventID    string `json:"lastEventId"`
		ReconnectToken string `json:"reconnectToken"`
	} `json:"cursor"`
	Proven *string  `json:"proven"`
	Errors []string `json:"errors"`
}

// driveRealtime drives the method's open *ResumableConnection: the grid's send through Send, then
// take values from Events(); a value on Errors() is terminal, traced and ends the reads. A send's
// error ends them too, observed as a call's (sendObserved). Then Close, and the connection's
// cursor and proven transport.
func driveRealtime(s streamCall) streamed {
	out := s.method.CallSlice(s.args)
	if err := errOf(out[1]); err != nil {
		return openFailed(err)
	}
	conn := out[0]
	rt := &realtimeTrace{Errors: []string{}}
	unsent, err := sendAll(conn, s)
	if err != nil {
		return streamed{err: err}
	}
	frames, failed := []any{}, unsent
	if unsent == nil {
		if frames, failed, err = liveFrames(conn, s, rt); err != nil {
			return streamed{err: err}
		}
	}
	if _, err := invoke(conn, "Close"); err != nil {
		return streamed{err: err}
	}
	errs, _ := invoke(conn, "Errors")
	for v, ok := errs[0].Recv(); ok; v, ok = errs[0].Recv() {
		rt.Errors = append(rt.Errors, errOf(v).Error())
	}
	if err := settled(conn, rt); err != nil {
		return streamed{err: err}
	}
	st := &streamTrace{Yields: len(frames), Realtime: rt}
	seen := observedStream("frames", frames, failed)
	if unsent != nil {
		seen = sendObserved(unsent)
	}
	return streamed{seen: seen, o: outcome{err: failed, via: "stream", stream: st, sent: unsent != nil}}
}

// sendAll sends the grid's send through Send in order; the first send's error, or a failure of
// the run.
func sendAll(conn reflect.Value, s streamCall) (error, error) {
	for _, text := range s.j.c.Send {
		out, err := invoke(conn, "Send", s.ctx, text)
		if err != nil {
			return nil, err
		}
		if failed := errOf(out[0]); failed != nil {
			return failed, nil
		}
	}
	return nil, nil
}

// sendObserved is a send's error as the grid observes a call's: no answer, a *DecodeError (an
// undecodable 2xx or one past the cap) with its answer's status, or an error status; else null.
func sendObserved(err error) any {
	var de *sdk.DecodeError
	var ce *sdk.ClientError
	switch {
	case noAnswerOf(err) != "":
		return map[string]any{"kind": noAnswerOf(err)}
	case errors.As(err, &de) && de.Response != nil:
		return map[string]any{"kind": "decode", "status": de.Response.StatusCode}
	case errors.As(err, &ce):
		return errorOf(ce)
	}
	return nil
}

// liveFrames reads take values off Events(), or until Errors() gives one; the frames, the error
// that ended them, or a failure of the run.
func liveFrames(conn reflect.Value, s streamCall, rt *realtimeTrace) ([]any, error, error) {
	events, err := invoke(conn, "Events")
	if err != nil {
		return nil, nil, err
	}
	errs, err := invoke(conn, "Errors")
	if err != nil {
		return nil, nil, err
	}
	cases := []reflect.SelectCase{{Dir: reflect.SelectRecv, Chan: events[0]}, {Dir: reflect.SelectRecv, Chan: errs[0]}}
	frames := []any{}
	for len(frames) < *s.j.c.Take {
		chosen, v, ok := reflect.Select(cases)
		switch {
		case !ok:
			return frames, errors.New("the connection closed its channels before take was reached"), nil
		case chosen == 1:
			rt.Errors = append(rt.Errors, errOf(v).Error())
			return frames, errOf(v), nil
		}
		frames = append(frames, v.Interface())
	}
	return frames, nil, nil
}

// settled reads the closed connection's cursor and proven transport into rt.
func settled(conn reflect.Value, rt *realtimeTrace) error {
	cursor, err := invoke(conn, "Cursor")
	if err != nil {
		return err
	}
	rt.Cursor.LastEventID, rt.Cursor.ReconnectToken = cursor[0].String(), cursor[1].String()
	proven, err := invoke(conn, "ProvenTransport")
	if err != nil {
		return err
	}
	if proven[1].Bool() {
		kind := proven[0].String()
		rt.Proven = &kind
	}
	return nil
}
