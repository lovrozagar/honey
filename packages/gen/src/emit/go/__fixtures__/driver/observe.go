package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"reflect"
	"sort"
	"strings"

	sdk "honey.test/driver/sdk"
)

// outcome is what a method returned: its answer (*T, []byte, string, a Result's Data, or none), its
// error and where that came from ("return", "result" for a Result's Err, or "stream" for one a
// stream delivered), a Result's summary and its Response, and a stream call's trace.
type outcome struct {
	value  reflect.Value
	err    error
	via    string
	result *resultTrace
	resp   *http.Response
	stream *streamTrace
	sent   bool // err is a realtime send's: graded as a call's, a *DecodeError included
}

// outcomeOf splits a method's return values: the last is its error; a Client.Safe() method's
// Result[T] carries the answer, its error in Err. Breaking the safe style fails the run: a safe call
// returning an API answer as its error or no Result, a Result off its contract (resultOf), a
// normal call answering a Result.
func outcomeOf(out []reflect.Value, safe bool) (outcome, error) {
	failed, _ := out[len(out)-1].Interface().(error)
	o := outcome{err: failed, via: "return"}
	result := len(out) == 2 && isResult(out[0].Type())
	switch {
	case result != safe && safe:
		return o, fmt.Errorf("the safe call answered %s, not a Result", out[0].Type())
	case result != safe:
		return o, fmt.Errorf("a normal call answered a %s", out[0].Type())
	case safe && isAnswer(failed):
		return o, fmt.Errorf("the safe call returned an API answer as its error, %T: %w", failed, failed)
	case len(out) == 1:
		return o, nil
	case !result:
		o.value = out[0]
		return o, nil
	case failed != nil:
		return o, nil
	}
	return resultOf(out[0], o)
}

// resultOf reads a Result into o: Ok's Data, or Err's error (via "result"), and its Response. A
// Result without its response, an Err holding no answer, or one whose response is not its error's
// fails the run.
func resultOf(value reflect.Value, o outcome) (outcome, error) {
	o.resp, _ = value.FieldByName("Response").Interface().(*http.Response)
	if o.resp == nil {
		return o, errors.New("a Result without its response")
	}
	data := value.FieldByName("Data")
	o.result = &resultTrace{
		OK:       value.MethodByName("Ok").Call(nil)[0].Bool(),
		Status:   o.resp.StatusCode,
		Data:     !data.IsZero(),
		Response: true,
	}
	failed, _ := value.FieldByName("Err").Interface().(error)
	switch {
	case failed == nil:
		o.value = data
		return o, nil
	case !isAnswer(failed):
		return o, fmt.Errorf("an Err holding no answer, %T: %w", failed, failed)
	case answerResponse(failed) != o.resp:
		return o, errors.New("an Err whose response is not its error's")
	}
	o.err, o.via = failed, "result"
	return o, nil
}

// isResult reports whether t is a Client.Safe() method's Result[T].
func isResult(t reflect.Type) bool {
	return t.Kind() == reflect.Struct && strings.HasPrefix(t.Name(), "Result[")
}

// isAnswer reports whether err is an answer the safe style moves into Err: an error status or a
// *DecodeError.
func isAnswer(err error) bool {
	var ce *sdk.ClientError
	var de *sdk.DecodeError
	return errors.As(err, &ce) || errors.As(err, &de)
}

// answerResponse is the response an answer's error holds.
func answerResponse(err error) *http.Response {
	var ce *sdk.ClientError
	if errors.As(err, &ce) {
		return ce.Response
	}
	var de *sdk.DecodeError
	errors.As(err, &de)
	return de.Response
}

// gridError reports whether err is an outcome the grid observes: an error status, no answer (a
// timeout, a lost or refused connection), or, for a call, a 2xx whose body did not decode. An
// event of a stream that does not decode is none: it fails the run.
func gridError(err error, stream bool) bool {
	var ce *sdk.ClientError
	return errors.As(err, &ce) || noAnswerOf(err) != "" || (!stream && isUndecodable(err))
}

// noAnswerOf is how err failed with no answer, as the grid names it: "timeout" for a lapsed
// deadline; "transport" for a connection refused or lost, the *net.OpError a dial or read failed
// with or the io.ErrUnexpectedEOF net/http reads from a body cut mid-answer (an event stream's
// wrapped as a call's, driveSSE holds); "" for any other.
func noAnswerOf(err error) string {
	var op *net.OpError
	switch {
	case errors.Is(err, context.DeadlineExceeded):
		return "timeout"
	case errors.As(err, &op), errors.Is(err, io.ErrUnexpectedEOF):
		return "transport"
	}
	return ""
}

// isUndecodable reports whether err is a 2xx answer whose body did not decode or ran past the cap:
// a *sdk.DecodeError.
func isUndecodable(err error) bool {
	var de *sdk.DecodeError
	return errors.As(err, &de)
}

// observedOf normalizes a call's outcome to the grid's Observed: no answer (a timeout or
// transport), a decode with the 2xx status, the raw response for raw: true, error for an error
// status, else bytes for a binary answer and data for any other (the JSON of the answer, a text
// answer as a string, the stored body for a method with no typed answer, with the typed response
// headers when the plan has them). o.err, when set, is a grid error.
func observedOf(j job, o outcome, resp *http.Response, target any) (any, error) {
	var ce *sdk.ClientError
	switch {
	case o.err != nil && noAnswerOf(o.err) != "":
		return map[string]any{"kind": noAnswerOf(o.err)}, nil
	case o.err != nil && isUndecodable(o.err) && resp == nil:
		return nil, fmt.Errorf("a decode failure without a response to read the status from: %w", o.err)
	case o.err != nil && isUndecodable(o.err):
		return map[string]any{"kind": "decode", "status": resp.StatusCode}, nil
	case o.err != nil && !errors.As(o.err, &ce):
		return nil, fmt.Errorf("an error the grid has no Observed for: %w", o.err)
	case j.c.Raw:
		return rawOf(resp)
	case ce != nil:
		return errorOf(ce), nil
	case resp == nil:
		return nil, errors.New("the call succeeded without a response to read the status from")
	}
	status := resp.StatusCode
	if o.result != nil {
		status = o.result.Status
	}
	data := payload(o.value)
	switch j.p.Response {
	case "binary":
		return bytesOf(data, status)
	case "none":
		var err error
		if data, err = untypedOf(resp); err != nil {
			return nil, err
		}
	}
	seen := map[string]any{"data": data, "kind": "data", "status": status}
	if target != nil {
		headers, err := headersOf(target, j.p.ResponseHeaders.Fields)
		if err != nil {
			return nil, err
		}
		seen["headers"] = headers
	}
	return seen, nil
}

// payload is v with one pointer level removed; nil for a nil pointer or no answer at all.
func payload(v reflect.Value) any {
	if !v.IsValid() {
		return nil
	}
	if v.Kind() == reflect.Pointer {
		if v.IsNil() {
			return nil
		}
		v = v.Elem()
	}
	return v.Interface()
}

// bytesOf is a binary answer as the grid observes it: its size and SHA-256.
func bytesOf(data any, status int) (any, error) {
	b, ok := data.([]byte)
	if !ok && data != nil {
		return nil, fmt.Errorf("a binary answer came back as %T, not []byte", data)
	}
	sum := sha256.Sum256(b)
	return map[string]any{"kind": "bytes", "sha256": hex.EncodeToString(sum[:]), "size": len(b), "status": status}, nil
}

// untypedOf is the answer to a method the document types none for (no 2xx declared): the body
// WithResponseInto stored, as JSON when it is JSON, as text when it is not, nil when empty. It is
// the rule errorOf applies to an error body.
func untypedOf(resp *http.Response) (any, error) {
	body, err := io.ReadAll(resp.Body)
	switch {
	case err != nil:
		return nil, fmt.Errorf("read the stored body: %w", err)
	case len(body) == 0:
		return nil, nil
	case json.Valid(body):
		return json.RawMessage(body), nil
	}
	return string(body), nil
}

// rawOf is the response WithResponseInto stored: its status, its headers (names lower case, a
// repeated one joined with ", ") and its body as text.
func rawOf(resp *http.Response) (any, error) {
	if resp == nil {
		return nil, errors.New("raw: true, and the call stored no response")
	}
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("raw: read the stored body: %w", err)
	}
	headers := map[string]string{}
	for name, values := range resp.Header {
		headers[strings.ToLower(name)] = strings.Join(values, ", ")
	}
	return map[string]any{"body": string(body), "headers": headers, "kind": "raw", "status": resp.StatusCode}, nil
}

// errorOf is an error status as the grid observes it: its status, honey error key (null without
// one) and the body, as JSON when it is JSON.
func errorOf(ce *sdk.ClientError) any {
	seen := map[string]any{"errorKey": nil, "kind": "error", "status": ce.StatusCode}
	if ce.Key != "" {
		seen["errorKey"] = string(ce.Key)
	}
	switch {
	case json.Valid(ce.Body):
		seen["body"] = json.RawMessage(ce.Body)
	case len(ce.Body) > 0:
		seen["body"] = string(ce.Body)
	}
	return seen
}

// headersOf reads the <Op>Headers struct WithHeadersInto filled: each declared header by its
// field, its name lower case, a string kind as is and any other as its JSON; an unset pointer
// field is left out.
func headersOf(target any, fields map[string]string) (map[string]string, error) {
	h := reflect.ValueOf(target).Elem()
	out := map[string]string{}
	for name, fieldName := range fields {
		field := h.FieldByName(fieldName)
		if !field.IsValid() {
			return nil, fmt.Errorf("%s has no field %s", h.Type(), fieldName)
		}
		value := payload(field)
		if value == nil {
			continue
		}
		if text, ok := value.(string); ok {
			out[strings.ToLower(name)] = text
			continue
		}
		encoded, err := json.Marshal(value)
		if err != nil {
			return nil, fmt.Errorf("%s.%s: %w", h.Type(), fieldName, err)
		}
		out[strings.ToLower(name)] = string(encoded)
	}
	return out, nil
}

// sortedNames is m's keys in order, so options apply the same way on every run.
func sortedNames(m map[string]string) []string {
	names := make([]string, 0, len(m))
	for name := range m {
		names = append(names, name)
	}
	sort.Strings(names)
	return names
}
