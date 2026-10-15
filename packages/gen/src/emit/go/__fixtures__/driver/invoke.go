package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"reflect"
	"strings"
	"time"

	sdk "honey.test/driver/sdk"
)

// call is the grid's Call. Every member is listed so strict decoding knows it; the ones the
// driver cannot express yet are refused by refusal.
type call struct {
	Body           *body                      `json:"body"`
	Headers        map[string]string          `json:"headers"`
	LastEventID    string                     `json:"lastEventId"`
	Operation      string                     `json:"operation"`
	Origin         string                     `json:"origin"`
	Params         map[string]string          `json:"params"`
	Raw            bool                       `json:"raw"`
	ReconnectToken string                     `json:"reconnectToken"`
	Route          json.RawMessage            `json:"route"`
	Search         map[string]json.RawMessage `json:"search"`
	Send           []string                   `json:"send"`
	Take           *int                       `json:"take"`
	TimeoutMs      *int64                     `json:"timeoutMs"`
}

// body is the grid's Body: a JSON value, or binary bytes of a size.
type body struct {
	Kind        string          `json:"kind"`
	Value       json.RawMessage `json:"value"`
	ContentType string          `json:"contentType"`
	Size        int             `json:"size"`
}

// job is one call of the cell: what the grid asks, the method's plan, and the script's directives.
type job struct {
	c call
	p plan
	d directives
}

// refusal names what of j the driver cannot express yet; nil when it can.
func refusal(j job) error {
	c, p := j.c, j.p
	switch {
	case p.Stream != nil:
		return fmt.Errorf("the operation streams (%s): events and frames are not driven yet", *p.Stream)
	case c.LastEventID != "" || c.ReconnectToken != "" || c.Send != nil || c.Take != nil:
		return errors.New("stream controls (lastEventId, reconnectToken, send, take) are not driven yet")
	case c.Body != nil && c.Body.Kind != "json" && c.Body.Kind != "binary":
		return fmt.Errorf("a %s body is not sent yet", c.Body.Kind)
	case c.Body != nil && p.Body == nil:
		return fmt.Errorf("the call has a %s body, and the method takes no body parameter", c.Body.Kind)
	case c.Body != nil && (c.Body.Kind == "binary") != (*p.Body == "binary"):
		return fmt.Errorf("the call has a %s body, and the method a %s body parameter", c.Body.Kind, *p.Body)
	case j.d.OneShotBody && (c.Body == nil || c.Body.Kind != "binary"):
		return errors.New("oneShotBody is scripted for a call without a binary body")
	}
	return nil
}

// perform sends call i, c, by its plan and returns what it observed: null for a Go error the grid
// has no Observed for when a script is given, a failure of the run without one.
func (r *runner) perform(i int, c call) (any, error) {
	p, ok := r.in.Plans[c.Operation]
	if !ok {
		return nil, errors.New("no call plan names this operation")
	}
	j := job{c: c, p: p, d: r.script.directivesOf(i)}
	method, err := methodOf(r.client, p)
	if err != nil {
		return nil, err
	}
	if err := refusal(j); err != nil {
		return nil, err
	}
	var resp *http.Response
	reqOpts, target, err := requestOptions(r.in, j, &resp)
	if err != nil {
		return nil, err
	}
	time.Sleep(time.Duration(j.d.SleepMs) * time.Millisecond)
	r.rec.begin(i)
	/* the clock starts before the ctx, so elapsedMs never undercuts a caller deadline */
	start := time.Now()
	ctx, release := j.d.ctxOf()
	defer release()
	args, err := argsOf(method.Type(), ctx, j, reqOpts)
	if err != nil {
		return nil, err
	}
	o := outcomeOf(method.CallSlice(args))
	r.rec.called(time.Since(start), o, j.d.IsKeys)
	if o.err != nil && !gridError(o.err) {
		if r.script == nil {
			return nil, o.err
		}
		return nil, nil
	}
	return observedOf(j, o, resp, target)
}

// methodOf walks the plan's resource fields from client to the method.
func methodOf(client *sdk.Client, p plan) (reflect.Value, error) {
	at := reflect.ValueOf(client)
	for _, name := range p.Members {
		field := at.Elem().FieldByName(name)
		if !field.IsValid() {
			return reflect.Value{}, fmt.Errorf("%s has no resource field %s", at.Type(), name)
		}
		at = field
	}
	method := at.MethodByName(p.Method)
	if !method.IsValid() {
		return reflect.Value{}, fmt.Errorf("%s has no method %s", at.Type(), p.Method)
	}
	return method, nil
}

// requestOptions are the call's per-call overrides, plus the raw response the status is read
// from and, for a plan with typed response headers, WithHeadersInto over a new <Op>Headers (the
// struct is returned beside them).
func requestOptions(in input, j job, resp **http.Response) ([]sdk.RequestOption, any, error) {
	opts := []sdk.RequestOption{sdk.WithResponseInto(resp)}
	switch j.c.Origin {
	case "":
	case "alt":
		if in.Alt == "" {
			return nil, nil, errors.New("the call goes to the alt origin, and the input names none")
		}
		opts = append(opts, sdk.WithBaseURL(in.Alt))
	default:
		return nil, nil, fmt.Errorf("origin %q is not one the driver knows", j.c.Origin)
	}
	if j.c.TimeoutMs != nil {
		opts = append(opts, sdk.WithTimeout(time.Duration(*j.c.TimeoutMs)*time.Millisecond))
	}
	if j.p.ResponseHeaders == nil {
		return opts, nil, nil
	}
	into, target, ok := headerTarget(j.p.Operation)
	if !ok {
		return nil, nil, errors.New("the plan declares response headers, and targets.go has no target for them")
	}
	return append(opts, into), target, nil
}

// argsOf builds the method's arguments: ctx, the path params in plan order, the body, the
// <Op>Opts, then the RequestOptions (a header the method does not declare among them).
func argsOf(t reflect.Type, ctx context.Context, j job, reqOpts []sdk.RequestOption) ([]reflect.Value, error) {
	want := 1 + len(j.p.PathParams) + 2
	if j.p.Body != nil {
		want++
	}
	if t.NumIn() != want {
		return nil, fmt.Errorf("the plan gives %d arguments, the method takes %d", want, t.NumIn())
	}
	args := []reflect.Value{reflect.ValueOf(ctx)}
	for _, name := range j.p.PathParams {
		value, ok := j.c.Params[name]
		if !ok {
			return nil, fmt.Errorf("path param %s is missing from the call", name)
		}
		args = append(args, reflect.ValueOf(value))
	}
	if j.p.Body != nil {
		arg, err := bodyArg(t.In(len(args)), j)
		if err != nil {
			return nil, fmt.Errorf("body: %w", err)
		}
		args = append(args, arg)
	}
	opts, undeclared, err := optsOf(t.In(len(args)), j)
	if err != nil {
		return nil, err
	}
	for _, name := range sortedNames(undeclared) {
		reqOpts = append(reqOpts, sdk.WithHeader(name, undeclared[name]))
	}
	return append(args, opts, reflect.ValueOf(reqOpts)), nil
}

// bodyArg is the body parameter (type t): a binary body as bytes i & 0xff behind an io.Reader (a
// bare one with oneShotBody), any other decoded from its JSON (a struct, url.Values, a string).
func bodyArg(t reflect.Type, j job) (reflect.Value, error) {
	if j.c.Body == nil || j.c.Body.Kind != "binary" {
		raw := json.RawMessage("null")
		if j.c.Body != nil {
			raw = j.c.Body.Value
		}
		return decodeAs(t, raw)
	}
	data := make([]byte, j.c.Body.Size)
	for i := range data {
		data[i] = byte(i)
	}
	var r io.Reader = bytes.NewReader(data)
	if j.d.OneShotBody {
		r = struct{ io.Reader }{r}
	}
	if !reflect.TypeOf(r).AssignableTo(t) {
		return reflect.Value{}, fmt.Errorf("a binary body cannot fill a %s parameter", t)
	}
	arg := reflect.New(t).Elem()
	arg.Set(reflect.ValueOf(r))
	return arg, nil
}

// optsOf fills a new <Op>Opts (t is its pointer type) from the call's search and its declared
// header params, each by the field the plan names, and the scripted IdempotencyKey; it returns the
// headers no param declares.
func optsOf(t reflect.Type, j job) (reflect.Value, map[string]string, error) {
	c, p := j.c, j.p
	opts := reflect.New(t.Elem())
	if j.d.IdempotencyKey != nil {
		key, _ := json.Marshal(*j.d.IdempotencyKey)
		if err := setField(opts.Elem(), "IdempotencyKey", key); err != nil {
			return reflect.Value{}, nil, err
		}
	}
	for name, raw := range c.Search {
		field, ok := p.Query[name]
		if !ok {
			return reflect.Value{}, nil, fmt.Errorf("query param %s is not declared", name)
		}
		if err := setField(opts.Elem(), field, raw); err != nil {
			return reflect.Value{}, nil, err
		}
	}
	undeclared := map[string]string{}
	for name, value := range c.Headers {
		field := declaredHeader(p, name)
		if field == "" {
			undeclared[name] = value
			continue
		}
		if err := setField(opts.Elem(), field, headerJSON(opts.Elem().FieldByName(field), value)); err != nil {
			return reflect.Value{}, nil, err
		}
	}
	return opts, undeclared, nil
}

// headerJSON is a header's text as JSON for field: quoted when the field holds a string, by pointer or
// not; as is for a number or a bool. A missing field is left to setField to refuse.
func headerJSON(field reflect.Value, value string) json.RawMessage {
	if field.IsValid() {
		t := field.Type()
		if t.Kind() == reflect.Pointer {
			t = t.Elem()
		}
		if t.Kind() == reflect.String {
			quoted, _ := json.Marshal(value)
			return quoted
		}
	}
	return json.RawMessage(value)
}

// declaredHeader is the Opts field of the header param named name in any casing, or "".
func declaredHeader(p plan, name string) string {
	for param, field := range p.Headers {
		if strings.EqualFold(param, name) {
			return field
		}
	}
	return ""
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
