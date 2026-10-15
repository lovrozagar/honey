// Command driver is the Go SDK's test driver (bit 12, G8.3-4, G11): one program for the unit
// behavior tests (emit/go/*.test.ts against a recording server), the conformance runner and the
// harness (against the reference app). The fixture compiles it beside the emitted SDK, replacing
// the placeholder import path below with the SDK's module path.
//
// Stdin is one JSON object, G11's envelope:
//
//	{ "cell": { "setup"?: Setup, "calls": Call[] }, "plans": { <operationId>: plan }, "base": url, "alt"?: url }
//
// cell is the grid's Cell as is (its other members are ignored); plans are the emitter's call plans
// (goCallPlans). Every call of a cell runs in order on one client, so state a call leaves (a
// refreshed token, a stale mark) reaches the next: a multi-step script is a cell with more calls.
// Stdout is the grid's Observed[] JSON, one per call. Any failure, and any Call or outcome this
// driver cannot express yet, exits 1 with the reason on stderr: a red cell, never a silent pass.
package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"time"

	sdk "honey.test/driver/sdk"
)

// input is the envelope on stdin.
type input struct {
	Cell  cell            `json:"cell"`
	Plans map[string]plan `json:"plans"`
	Base  string          `json:"base"`
	Alt   string          `json:"alt"`
}

// cell holds what the driver reads of a grid Cell; the calls are decoded strictly one by one.
type cell struct {
	Setup json.RawMessage   `json:"setup"`
	Calls []json.RawMessage `json:"calls"`
}

// auth is the grid's Auth: a bearer token, or a credential under a header name.
type auth struct {
	Kind  string `json:"kind"`
	Token string `json:"token"`
	Name  string `json:"name"`
	Value string `json:"value"`
}

// setup is the grid's Setup: the client-wide settings of a cell.
type setup struct {
	Auth      *auth             `json:"auth"`
	Headers   map[string]string `json:"headers"`
	Redirect  string            `json:"redirect"`
	TimeoutMs *int64            `json:"timeoutMs"`
}

// plan is one method's call plan, in the emitter's names (emit/go/sdk-method.ts GoMethodCall).
type plan struct {
	Operation  string            `json:"operation"`
	Members    []string          `json:"members"`
	Method     string            `json:"method"`
	PathParams []string          `json:"pathParams"`
	Body       bool              `json:"body"`
	Query      map[string]string `json:"query"`
	Headers    map[string]string `json:"headers"`
	Response   string            `json:"response"`
	Stream     *string           `json:"stream"`
}

func main() {
	if err := drive(os.Stdin, os.Stdout); err != nil {
		fmt.Fprintln(os.Stderr, "driver:", err)
		os.Exit(1)
	}
}

// drive runs every call of the cell on stdin on one client and prints what each observed.
func drive(r io.Reader, w io.Writer) error {
	var in input
	if err := json.NewDecoder(r).Decode(&in); err != nil {
		return fmt.Errorf("read input: %w", err)
	}
	cfg, err := configOf(in)
	if err != nil {
		return err
	}
	client := sdk.NewClient(cfg)
	observed := make([]any, 0, len(in.Cell.Calls))
	for i, raw := range in.Cell.Calls {
		var c call
		if err := strict(raw, &c); err != nil {
			return fmt.Errorf("call %d: %w", i, err)
		}
		seen, err := perform(client, in, c)
		if err != nil {
			return fmt.Errorf("call %d (%s): %w", i, c.Operation, err)
		}
		observed = append(observed, seen)
	}
	return json.NewEncoder(w).Encode(observed)
}

// strict decodes raw into v refusing unknown members: a Call or Setup field this driver does not
// know yet fails the cell instead of being dropped.
func strict(raw json.RawMessage, v any) error {
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.DisallowUnknownFields()
	return dec.Decode(v)
}

// configOf is the client config a cell's setup asks for, aimed at base.
func configOf(in input) (sdk.Config, error) {
	var s setup
	if len(in.Cell.Setup) > 0 {
		if err := strict(in.Cell.Setup, &s); err != nil {
			return sdk.Config{}, fmt.Errorf("setup: %w", err)
		}
	}
	cfg := sdk.Config{BaseURL: in.Base, Headers: map[string]string{}}
	for name, value := range s.Headers {
		cfg.Headers[name] = value
	}
	switch {
	case s.Auth == nil:
	case s.Auth.Kind == "bearer":
		cfg.BearerToken = s.Auth.Token
	case s.Auth.Kind == "header":
		cfg.Headers[s.Auth.Name] = s.Auth.Value
	default:
		return sdk.Config{}, fmt.Errorf("setup: auth kind %q is not one the driver knows", s.Auth.Kind)
	}
	switch s.Redirect {
	case "":
	case "follow":
		cfg.Redirect = sdk.RedirectFollow
	case "same-origin":
		cfg.Redirect = sdk.RedirectSameOrigin
	default:
		return sdk.Config{}, fmt.Errorf("setup: redirect %q is not one the driver knows", s.Redirect)
	}
	if s.TimeoutMs != nil {
		cfg.Timeout = time.Duration(*s.TimeoutMs) * time.Millisecond
	}
	return cfg, nil
}
