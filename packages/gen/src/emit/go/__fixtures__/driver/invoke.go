package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
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

// refusal names what of c, on the method p plans, the driver cannot express yet; nil when it can.
func refusal(c call, p plan) error {
	switch {
	case p.Stream != nil:
		return fmt.Errorf("the operation streams (%s): events and frames are not driven yet", *p.Stream)
	case p.Response != "json" && p.Response != "none":
		return fmt.Errorf("the operation answers %s: bytes and text are not observed yet", p.Response)
	case c.Raw:
		return errors.New("a raw response (raw: true) is not observed yet")
	case c.LastEventID != "" || c.ReconnectToken != "" || c.Send != nil || c.Take != nil:
		return errors.New("stream controls (lastEventId, reconnectToken, send, take) are not driven yet")
	case c.Body != nil && c.Body.Kind != "json":
		return fmt.Errorf("a %s body is not sent yet", c.Body.Kind)
	case c.Body != nil && !p.Body:
		return errors.New("the call has a JSON body the method takes no parameter for")
	}
	return nil
}

// perform sends c on client by its plan and returns what it observed.
func perform(client *sdk.Client, in input, c call) (any, error) {
	p, ok := in.Plans[c.Operation]
	if !ok {
		return nil, errors.New("no call plan names this operation")
	}
	if err := refusal(c, p); err != nil {
		return nil, err
	}
	method, err := methodOf(client, p)
	if err != nil {
		return nil, err
	}
	var resp *http.Response
	reqOpts, err := requestOptions(in, c, &resp)
	if err != nil {
		return nil, err
	}
	args, err := argsOf(method.Type(), c, p, reqOpts)
	if err != nil {
		return nil, err
	}
	return observe(method.CallSlice(args), resp)
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

// requestOptions are the call's per-call overrides, plus the raw response the status is read from.
func requestOptions(in input, c call, resp **http.Response) ([]sdk.RequestOption, error) {
	opts := []sdk.RequestOption{sdk.WithResponseInto(resp)}
	switch c.Origin {
	case "":
	case "alt":
		if in.Alt == "" {
			return nil, errors.New("the call goes to the alt origin, and the input names none")
		}
		opts = append(opts, sdk.WithBaseURL(in.Alt))
	default:
		return nil, fmt.Errorf("origin %q is not one the driver knows", c.Origin)
	}
	if c.TimeoutMs != nil {
		opts = append(opts, sdk.WithTimeout(time.Duration(*c.TimeoutMs)*time.Millisecond))
	}
	return opts, nil
}

// argsOf builds the method's arguments: ctx, the path params in plan order, the body, the
// <Op>Opts, then the RequestOptions (a header the method does not declare among them).
func argsOf(t reflect.Type, c call, p plan, reqOpts []sdk.RequestOption) ([]reflect.Value, error) {
	args := []reflect.Value{reflect.ValueOf(context.Background())}
	for _, name := range p.PathParams {
		value, ok := c.Params[name]
		if !ok {
			return nil, fmt.Errorf("path param %s is missing from the call", name)
		}
		args = append(args, reflect.ValueOf(value))
	}
	if p.Body {
		raw := json.RawMessage("null")
		if c.Body != nil {
			raw = c.Body.Value
		}
		arg, err := decodeAs(t.In(len(args)), raw)
		if err != nil {
			return nil, fmt.Errorf("body: %w", err)
		}
		args = append(args, arg)
	}
	opts, undeclared, err := optsOf(t.In(len(args)), c, p)
	if err != nil {
		return nil, err
	}
	for _, name := range sortedNames(undeclared) {
		reqOpts = append(reqOpts, sdk.WithHeader(name, undeclared[name]))
	}
	args = append(args, opts, reflect.ValueOf(reqOpts))
	if len(args) != t.NumIn() {
		return nil, fmt.Errorf("the plan gives %d arguments, the method takes %d", len(args), t.NumIn())
	}
	return args, nil
}

// optsOf fills a new <Op>Opts (t is its pointer type) from the call's search and its declared
// header params, each by the field the plan names; it returns the headers no param declares.
func optsOf(t reflect.Type, c call, p plan) (reflect.Value, map[string]string, error) {
	opts := reflect.New(t.Elem())
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
		raw := json.RawMessage(value)
		if opts.Elem().FieldByName(field).Type().Elem().Kind() == reflect.String {
			raw, _ = json.Marshal(value)
		}
		if err := setField(opts.Elem(), field, raw); err != nil {
			return reflect.Value{}, nil, err
		}
	}
	return opts, undeclared, nil
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
