package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"reflect"
	"sort"
	"strings"

	sdk "honey.test/driver/sdk"
)

// outcome is what a method returned: its answer (*T, []byte, string, a safe-mode Data pointer, or
// none), its error and where that came from, and a safe-mode SDKResult's summary.
type outcome struct {
	value  reflect.Value
	err    error
	via    string
	result *resultTrace
}

// outcomeOf splits a method's return values: the last is its error; a safe-mode SDKResult[T] the
// method returned without one carries the answer, its error status in Err.
func outcomeOf(out []reflect.Value) outcome {
	failed, _ := out[len(out)-1].Interface().(error)
	o := outcome{err: failed, via: "return"}
	if len(out) == 1 {
		return o
	}
	value := out[0]
	if !isResult(value.Type()) {
		o.value = value
		return o
	}
	if failed != nil {
		return o
	}
	o.value = value.FieldByName("Data")
	o.result = &resultTrace{
		OK:       value.MethodByName("OK").Call(nil)[0].Bool(),
		Status:   int(value.FieldByName("Status").Int()),
		Data:     !o.value.IsNil(),
		Response: !value.FieldByName("Response").IsNil(),
	}
	if apiErr := value.FieldByName("Err"); !apiErr.IsNil() {
		o.err, o.via = apiErr.Interface().(error), "result"
	}
	return o
}

// isResult reports whether t is a safe-mode SDKResult[T].
func isResult(t reflect.Type) bool {
	return t.Kind() == reflect.Struct && strings.HasPrefix(t.Name(), "SDKResult[")
}

// gridError reports whether err is an outcome the grid observes: an error status or a timeout.
func gridError(err error) bool {
	var ce *sdk.ClientError
	return errors.As(err, &ce) || errors.Is(err, context.DeadlineExceeded)
}

// observedOf normalizes a call's outcome to the grid's Observed: a timeout, the raw response for
// raw: true, error for an error status, else bytes for a binary answer and data for any other
// (the JSON of the answer, a text answer as a string, with the typed response headers when the
// plan has them). o.err, when set, is a grid error.
func observedOf(j job, o outcome, resp *http.Response, target any) (any, error) {
	var ce *sdk.ClientError
	switch {
	case o.err != nil && !errors.As(o.err, &ce):
		return map[string]any{"kind": "timeout"}, nil
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
	if j.p.Response == "binary" {
		return bytesOf(data, status)
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
