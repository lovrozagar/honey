// Command driver is the Go SDK's test driver (bit 12, G8.3-4, G11): one program for the unit
// behavior tests (emit/go/*.test.ts against a recording server), the conformance runner and the
// harness (against the reference app). The fixture compiles it beside the emitted SDK, replacing
// the placeholder import path below with the SDK's module path.
//
// Stdin is one JSON object, G11's envelope:
//
//	{ "cell": { "setup"?: Setup, "calls": Call[] }, "plans": { <operationId>: plan }, "base": url, "alt"?: url,
//	  "drop"?: url, "refused"?: url, "script"?: Script, "safe"?: bool }
//
// cell is the grid's Cell as is (its other members are ignored); plans are the emitter's call plans
// (goCallPlans); safe sends each call through client.Safe() (bit 21 i3), its Result read strictly. Every call of a cell runs in order on one client, so state a call leaves (a
// refreshed token, a stale mark) reaches the next: a multi-step script is a cell with more calls.
// Stdout is the grid's Observed[] JSON, one per call. Any failure, and any Call or outcome this
// driver cannot express, exits 1 with the reason on stderr: a red cell, never a silent pass.
//
// A streaming operation (stream.go) observes events (SSE) or frames (WebSocket in socket.go,
// realtime in live.go), driven by reflection alone, so every driver file builds against any SDK
// and a method of another shape is refused at run time. A stream call that has not ended after
// 10 s fails the run ("stream stalled").
//
// script (script.go; unit tests and the harness send one, the conformance runner never does) adds
// client config, hooks, OnLog, OnAuthExpired, per-call ctx directives, stream controls and opt-in
// trace members (log durations, a ClientError's Envelope), and stdout becomes
// { "observed": (Observed|null)[], "trace": Trace } (trace.go): a call ending in a Go error the
// grid has no Observed for observes null (a stream: what it delivered so far), its error traced,
// instead of failing the run.
package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"reflect"
	"time"

	sdk "honey.test/driver/sdk"
)

// input is the envelope on stdin.
type input struct {
	Cell    cell            `json:"cell"`
	Plans   map[string]plan `json:"plans"`
	Base    string          `json:"base"`
	Alt     string          `json:"alt"`
	Drop    string          `json:"drop"`
	Refused string          `json:"refused"`
	Script  json.RawMessage `json:"script"`
	Safe    bool            `json:"safe"`
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

	MaxResponseBytes *int64 `json:"maxResponseBytes"`
}

// plan is one method's call plan, in the emitter's names (emit/go/sdk-method.ts GoMethodCall).
type plan struct {
	Operation       string            `json:"operation"`
	Members         []string          `json:"members"`
	Method          string            `json:"method"`
	PathParams      []string          `json:"pathParams"`
	Body            *string           `json:"body"`
	Query           map[string]string `json:"query"`
	Headers         map[string]string `json:"headers"`
	Response        string            `json:"response"`
	ResponseHeaders *responseHeaders  `json:"responseHeaders"`
	Stream          *string           `json:"stream"`
}

// responseHeaders is a method's <Op>Headers struct: its type name, and each declared header (as
// the spec spells it) to its field.
type responseHeaders struct {
	Type   string            `json:"type"`
	Fields map[string]string `json:"fields"`
}

// runner runs a cell's calls on one client, recording into its trace when a script is given.
type runner struct {
	client *sdk.Client
	in     input
	script *script
	rec    *recorder
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
	s, err := scriptOf(in.Script, len(in.Cell.Calls))
	if err != nil {
		return fmt.Errorf("script: %w", err)
	}
	rec := &recorder{}
	s.apply(&cfg, rec)
	run := &runner{client: sdk.NewClient(cfg), in: in, script: s, rec: rec}
	observed := make([]any, 0, len(in.Cell.Calls))
	for i, raw := range in.Cell.Calls {
		var c call
		if err := strict(raw, &c); err != nil {
			return fmt.Errorf("call %d: %w", i, err)
		}
		seen, err := run.perform(i, c)
		if err != nil {
			return fmt.Errorf("call %d (%s): %w", i, c.Operation, err)
		}
		observed = append(observed, seen)
	}
	if s == nil {
		return json.NewEncoder(w).Encode(observed)
	}
	return json.NewEncoder(w).Encode(map[string]any{"observed": observed, "trace": rec.trace()})
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
	if s.MaxResponseBytes != nil {
		cfg.MaxResponseBytes = *s.MaxResponseBytes
	}
	return cfg, nil
}

// setField decodes raw into the named field of opts.
func setField(opts reflect.Value, name string, raw json.RawMessage) error {
	field := opts.FieldByName(name)
	if !field.IsValid() {
		return fmt.Errorf("%s has no field %s", opts.Type(), name)
	}
	value, err := decodeAs(field.Type(), raw)
	if err != nil {
		return fmt.Errorf("%s.%s: %w", opts.Type(), name, err)
	}
	field.Set(value)
	return nil
}

// decodeAs is raw decoded by encoding/json into a new value of type t.
func decodeAs(t reflect.Type, raw json.RawMessage) (reflect.Value, error) {
	ptr := reflect.New(t)
	if err := json.Unmarshal(raw, ptr.Interface()); err != nil {
		return reflect.Value{}, err
	}
	return ptr.Elem(), nil
}
