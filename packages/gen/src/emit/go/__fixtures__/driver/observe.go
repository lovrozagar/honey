package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"reflect"
	"sort"
	"strings"

	sdk "honey.test/driver/sdk"
)

// observe normalizes a method's return values to the grid's Observed: data for a success (the JSON
// of *T, null without a body), error for an error status, in either error mode. Anything else (a
// transport failure, a timeout) fails the call.
func observe(out []reflect.Value, resp *http.Response) (any, error) {
	failed, _ := out[len(out)-1].Interface().(error)
	if len(out) == 1 {
		if failed != nil {
			return errorOf(failed)
		}
		return dataOf(nil, resp)
	}
	value := out[0]
	if !isResult(value.Type()) {
		if failed != nil {
			return errorOf(failed)
		}
		return dataOf(value.Interface(), resp)
	}
	if failed != nil {
		return nil, failed
	}
	if apiErr := value.FieldByName("Err"); !apiErr.IsNil() {
		return errorOf(apiErr.Interface().(error))
	}
	data := value.FieldByName("Data").Interface()
	return map[string]any{"data": data, "kind": "data", "status": value.FieldByName("Status").Int()}, nil
}

// isResult reports whether t is a safe-mode SDKResult[T].
func isResult(t reflect.Type) bool {
	return t.Kind() == reflect.Struct && strings.HasPrefix(t.Name(), "SDKResult[")
}

// dataOf is a success: its decoded data and the status of the response WithResponseInto stored.
func dataOf(data any, resp *http.Response) (any, error) {
	if resp == nil {
		return nil, errors.New("the call succeeded without a response to read the status from")
	}
	return map[string]any{"data": data, "kind": "data", "status": resp.StatusCode}, nil
}

// errorOf is an error status as the grid observes it: its status, honey error key (null without
// one) and the body, as JSON when it is JSON. Any other error fails the call.
func errorOf(err error) (any, error) {
	var ce *sdk.ClientError
	if !errors.As(err, &ce) {
		if errors.Is(err, context.DeadlineExceeded) {
			return nil, fmt.Errorf("timed out (%w): the timeout outcome is not observed yet", err)
		}
		return nil, err
	}
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
	return seen, nil
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
