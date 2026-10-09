package sdk

// Go runtime regression checks, run by polyglot.regression.test.ts against an SDK generated from
// runtimeSpec, in this tree and in 3ab88ce. Every SDK method is called through reflection, so a
// signature that differs between the trees fails one check instead of the whole build. Each test
// prints `REGRESS {json}`; the TypeScript side asserts on that and on the recorded requests.

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"reflect"
	"strings"
	"testing"
	"time"
)

// regressReader is passed as an io.Reader instead of JSON-converted.
type regressReader string

func base() string { return os.Getenv("REGRESS_BASE") }

func report(v any) {
	b, _ := json.Marshal(v)
	fmt.Println("REGRESS " + string(b))
}

// invoke calls fn(ctx, args..., nil opts); each arg is JSON-converted into the parameter's type.
func invoke(t *testing.T, fn any, args ...any) []reflect.Value {
	t.Helper()
	v := reflect.ValueOf(fn)
	ft := v.Type()
	if ft.NumIn() != len(args)+2 {
		t.Fatalf("signature %s does not take %d argument(s) between ctx and opts", ft, len(args))
	}
	in := []reflect.Value{reflect.ValueOf(context.Background())}
	for i, a := range args {
		if r, ok := a.(regressReader); ok {
			in = append(in, reflect.ValueOf(strings.NewReader(string(r))))
			continue
		}
		p := reflect.New(ft.In(i + 1))
		raw, _ := json.Marshal(a)
		if err := json.Unmarshal(raw, p.Interface()); err != nil {
			t.Fatalf("argument %d into %s: %v", i, ft.In(i+1), err)
		}
		in = append(in, p.Elem())
	}
	in = append(in, reflect.Zero(ft.In(ft.NumIn()-1)))
	return v.Call(in)
}

func errOf(out []reflect.Value) error {
	last := out[len(out)-1]
	if last.IsNil() {
		return nil
	}
	return last.Interface().(error)
}

func valueJSON(out []reflect.Value) string {
	b, _ := json.Marshal(out[0].Interface())
	return string(b)
}

// drain consumes an iter.Seq2[SSEEvent, error] and returns each event's data.
func drain(seq reflect.Value) (data []string, err error) {
	yield := reflect.MakeFunc(seq.Type().In(0), func(args []reflect.Value) []reflect.Value {
		if e := args[1]; !e.IsNil() {
			err = e.Interface().(error)
			return []reflect.Value{reflect.ValueOf(false)}
		}
		data = append(data, args[0].FieldByName("Data").String())
		return []reflect.Value{reflect.ValueOf(true)}
	})
	seq.Call([]reflect.Value{yield})
	return data, err
}

func errString(err error) string {
	if err == nil {
		return ""
	}
	return err.Error()
}

// regression: H56
func TestH56BasePathKept(t *testing.T) {
	c := NewClient(Config{BaseURL: base() + "/api"})
	report(map[string]string{"err": errString(errOf(invoke(t, c.Users.Get, "1")))})
}

// regression: M (codegen-go.ts:133 path params)
func TestDotSegmentParams(t *testing.T) {
	c := NewClient(Config{BaseURL: base() + "/api"})
	errs := []string{}
	for _, id := range []string{"..", ".", ""} {
		errs = append(errs, errString(errOf(invoke(t, c.Users.Get, id))))
	}
	report(map[string]any{"errs": errs})
}

// regression: H42
func TestH42SseSendsMethodBodyAuth(t *testing.T) {
	c := NewClient(Config{BaseURL: base(), BearerToken: "tok"})
	data, err := drain(invoke(t, c.Chat.Send, map[string]string{"q": "hi"})[0])
	report(map[string]any{"data": data, "err": errString(err)})
}

// regression: H50
func TestH50FormBody(t *testing.T) {
	c := NewClient(Config{BaseURL: base()})
	report(map[string]string{"err": errString(errOf(invoke(t, c.Forms.Submit, map[string][]string{"name": {"form-value"}})))})
}

// regression: H50
func TestH50MultipartBody(t *testing.T) {
	c := NewClient(Config{BaseURL: base()})
	report(map[string]string{"err": errString(errOf(invoke(t, c.Files.Upload, map[string]string{"name": "multipart-value"})))})
}

// regression: M (go-type-emitter.ts:315-323 unions)
func TestUnionKeepsVariantData(t *testing.T) {
	c := NewClient(Config{BaseURL: base()})
	out := invoke(t, c.Shapes.Get)
	report(map[string]string{"err": errString(errOf(out)), "value": valueJSON(out)})
}

// regression: M (go-type-emitter.ts:363-388 additionalProperties)
func TestAdditionalPropertiesKept(t *testing.T) {
	c := NewClient(Config{BaseURL: base()})
	out := invoke(t, c.Extra.Get)
	report(map[string]string{"err": errString(errOf(out)), "value": valueJSON(out)})
}

// regression: M (codegen-go.ts:148-152 text bodies)
func TestTextBodyNotJSONDecoded(t *testing.T) {
	c := NewClient(Config{BaseURL: base()})
	out := invoke(t, c.Text.Get)
	report(map[string]string{"err": errString(errOf(out)), "value": valueJSON(out)})
}

// regression: L (client-go/runtime.go:167-176 refreshed token kept)
func TestH62AuthRetryResendsBody(t *testing.T) {
	refreshes := 0
	c := NewClient(Config{
		BaseURL:     base(),
		BearerToken: "old",
		OnAuthExpired: func(context.Context) (string, error) {
			refreshes++
			return "new", nil
		},
	})
	first := errString(errOf(invoke(t, c.Users.Create, map[string]string{"name": "retry-body"})))
	second := errString(errOf(invoke(t, c.Users.Get, "1")))
	report(map[string]any{"first": first, "refreshes": refreshes, "second": second})
}

// regression: H62
func TestH62RawUploadNeverResentEmpty(t *testing.T) {
	c := NewClient(Config{
		BaseURL:       base(),
		BearerToken:   "old",
		OnAuthExpired: func(context.Context) (string, error) { return "new", nil },
	})
	report(map[string]string{"err": errString(errOf(invoke(t, c.Raw.Send, regressReader("raw-retry-body"))))})
}

// regression: M (client-go/runtime.go:270,362-372 redirects)
func TestCrossHostRedirectDropsHeaders(t *testing.T) {
	c := NewClient(Config{BaseURL: base(), Headers: map[string]string{"X-Api-Key": "secret"}})
	report(map[string]string{"err": errString(errOf(invoke(t, c.Hop.Get)))})
}

// regression: M (client-go/runtime.go:55 Config.Timeout)
func TestConfigTimeoutHonored(t *testing.T) {
	c := NewClient(Config{BaseURL: base(), Timeout: 300 * time.Millisecond})
	start := time.Now()
	err := errOf(invoke(t, c.Slow.Get))
	report(map[string]any{"err": errString(err), "ms": time.Since(start).Milliseconds()})
}

// regression: M (client-go/invalidation.go:103-124)
func TestParamlessMutationMarksPattern(t *testing.T) {
	var stale []bool
	c := NewClient(Config{
		BaseURL:      base(),
		Invalidation: &InvalidationConfig{StaleTime: 60_000},
		OnRequest: []func(*RequestContext) error{func(ctx *RequestContext) error {
			stale = append(stale, ctx.IsStale)
			return nil
		}},
	})
	invoke(t, c.Users.Create, map[string]string{"name": "n"})
	invoke(t, c.Users.Get, "1")
	invoke(t, c.Users.Get, "1")
	report(map[string]any{"stale": stale})
}

// regression: L (client-go/sse.go:70-90)
func TestSseLineEndingsAndPartialEvent(t *testing.T) {
	c := NewClient(Config{BaseURL: base()})
	data, err := drain(invoke(t, c.Events.List)[0])
	report(map[string]any{"data": data, "err": errString(err)})
}

var _ = http.MethodGet
