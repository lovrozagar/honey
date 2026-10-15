import { describe, expect, it } from "vitest"
import { compileGo } from "./__fixtures__/compiled.ts"
import { goRequired, hasGo } from "./__fixtures__/go-env.ts"
import { generateGoSdk } from "./sdk.ts"

type Json = Record<string, unknown>
type Files = Readonly<Record<string, string>>

const STRING = { type: "string" }
const ref = (name: string): Json => ({ $ref: `#/components/schemas/${name}` })
const object = (properties: Json, required: string[] = []) => ({ properties, required, type: "object" })
const json = (schema: Json) => ({ content: { "application/json": { schema } } })
const path = (name: string): Json => ({ in: "path", name, required: true, schema: STRING })
const query = (name: string, schema: Json = STRING): Json => ({ in: "query", name, schema })

/** An operation answering 200 with `ok`, or 204 without it. */
const op = (operationId: string, { body, ok, parameters }: { body?: Json; ok?: Json; parameters?: Json[] } = {}) => ({
	operationId,
	...(parameters ? { parameters } : {}),
	...(body ? { requestBody: { ...json(body), required: true } } : {}),
	responses: ok ? { 200: { ...json(ok), description: "ok" } } : { 204: { description: "done" } },
})

/** A minimal OpenAPI 3.1 document. */
const document = (paths: Json, schemas: Json, extra: Json = {}): Json => ({
	components: { schemas },
	info: { title: "Calls", version: "1" },
	openapi: "3.1.0",
	paths,
	...extra,
})

const USERS = {
	User: object({ id: STRING, name: STRING }, ["id", "name"]),
	UserCreateInput: object({ name: STRING }, ["name"]),
}

/** One namespace per depth: users.*, users.profile.*, checkout.sessions.*, a bare getUser, items.update with options. */
const SHOP = document(
	{
		"/checkout/{org}/sessions/{session}": {
			/* listed out of path order: the signature follows the path */
			post: op("checkout.sessions.create", {
				body: ref("SessionInput"),
				ok: ref("Session"),
				parameters: [path("session"), path("org")],
			}),
		},
		"/items/{id}": {
			patch: op("items.update", {
				body: ref("ItemPatch"),
				ok: ref("Item"),
				parameters: [
					path("id"),
					query("fields"),
					query("limit", { type: "integer" }),
					{ in: "header", name: "X-Trace", schema: STRING },
				],
			}),
		},
		"/users": {
			get: op("users.list", { ok: ref("UserPage") }),
			post: op("users.create", { body: ref("UserCreateInput"), ok: ref("User") }),
		},
		"/users/{id}": {
			delete: op("users.delete", { parameters: [path("id")] }),
			get: op("getUser", { ok: ref("User"), parameters: [path("id")] }),
		},
		"/users/{id}/profile": { get: op("users.profile.get", { ok: ref("User"), parameters: [path("id")] }) },
	},
	{
		...USERS,
		Item: object({ id: STRING }, ["id"]),
		ItemPatch: object({ name: STRING }),
		Session: object({ id: STRING }, ["id"]),
		SessionInput: object({ amount: { type: "integer" } }, ["amount"]),
		UserPage: object({ items: { items: ref("User"), type: "array" } }, ["items"]),
	},
)

/** Names a careless emitter collides: a receiver letter as a param, keywords, a runtime type, enum labels. */
const NAMES = document(
	{
		"/config": { get: op("config.get", { ok: ref("Config") }) },
		"/queue": { get: op("queue.list", { ok: ref("Ack"), parameters: [query("q"), query("order", ref("Status"))] }) },
		"/queue/{q}": { get: op("queue.get", { ok: ref("Ack"), parameters: [path("q")] }) },
		"/select/{url}/{ctx}": { get: op("select.range", { ok: ref("Ack"), parameters: [path("url"), path("ctx")] }) },
		"/type/{type}": { get: op("type.get", { ok: ref("Ack"), parameters: [path("type")] }) },
	},
	{
		Ack: object({ ok: { type: "boolean" } }),
		Config: object({ region: STRING }, ["region"]),
		Status: { enum: ["-created_at", "created_at", ""], type: "string" },
	},
)

/**
 * A consumer program around `body`: an SDK client over a recording transport. Each request is
 * noted as `METHOD url[ x-trace=…][ body]` (query sorted) and answered from `replies` (200 `{}` by
 * default); it prints every `section`'s notes as one JSON object.
 */
const PROGRAM = `package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"

	sdk "{{module}}"
)

type reply struct {
	status int
	body   string
}

var (
	ctx       = context.Background()
	replies   = map[string]reply{}
	out       = map[string][]string{}
	current   = "main"
	transport = &http.Client{Transport: recorder{}}
)

func section(name string) { current = name }

func note(parts ...any) { out[current] = append(out[current], strings.TrimSpace(fmt.Sprintln(parts...))) }

type recorder struct{}

func (recorder) RoundTrip(req *http.Request) (*http.Response, error) {
	line := req.Method + " " + req.URL.Scheme + "://" + req.URL.Host + req.URL.EscapedPath()
	if req.URL.RawQuery != "" {
		line += "?" + req.URL.Query().Encode()
	}
	if trace := req.Header.Get("X-Trace"); trace != "" {
		line += " x-trace=" + trace
	}
	if req.Body != nil {
		sent, _ := io.ReadAll(req.Body)
		if text := strings.TrimSpace(string(sent)); text != "" {
			line += " " + text
		}
	}
	note(line)
	answer, ok := replies[req.Method+" "+req.URL.Path]
	if !ok {
		answer = reply{200, "{}"}
	}
	return &http.Response{
		Body:       io.NopCloser(strings.NewReader(answer.body)),
		Header:     http.Header{"Content-Type": {"application/json"}},
		Request:    req,
		StatusCode: answer.status,
	}, nil
}

func client(base string) *sdk.Client {
	return sdk.NewClient(sdk.Config{BaseURL: base, HTTPClient: transport})
}

func must[T any](v T, err error) T {
	if err != nil {
		note("error:", err)
	}
	return v
}

func main() {
{{body}}
	if err := json.NewEncoder(os.Stdout).Encode(out); err != nil {
		os.Exit(1)
	}
}
`

/** PROGRAM importing the SDK as `module`, running `body`. */
const program = (module: string, body: string) =>
	PROGRAM.replace("{{module}}", () => module).replace("{{body}}", () => body)

type Run = { built: boolean; vet: readonly string[]; out: Record<string, string[]> | undefined; stderr: string }

/** `files` built and vetted with the consumer `body` beside them, which is run when it builds. */
function check(files: Files, module: string, body: string): Run {
	const sdk = compileGo(files, { main: program(module, body) })
	if (!sdk.built) return { built: false, out: undefined, stderr: sdk.stderr, vet: sdk.vet }
	const ran = sdk.run()
	const out = ran.status === 0 ? (JSON.parse(ran.stdout) as Record<string, string[]>) : undefined
	return { built: true, out, stderr: ran.stderr, vet: sdk.vet }
}

/** `check` run once, on first use. */
function once(run: () => Run): () => Run {
	let memo: Run | undefined
	return () => (memo ??= run())
}

/** What a test asserts of a run: it builds, vets clean, and the notes of `section`. */
const seen = (run: Run, section = "main") => ({ built: run.built, out: run.out?.[section], vet: run.vet })

const shop = once(() =>
	check(
		generateGoSdk(SHOP, { modulePath: "example.com/shop" }).files,
		"example.com/shop",
		`	api := client("http://api.test")
	section("tree")
	must(api.Users.Create(ctx, sdk.UserCreateInput{Name: "Ada"}, nil))
	must(api.Users.List(ctx, nil))
	must(api.Users.Profile.Get(ctx, "u1", nil))
	must(api.Checkout.Sessions.Create(ctx, "o1", "s1", sdk.SessionInput{Amount: 5}, nil))
	must(api.GetUser(ctx, "u1", nil))
	section("signature")
	var _ func(context.Context, sdk.UserCreateInput, *sdk.UsersCreateOpts, ...sdk.RequestOption) (*sdk.User, error) = api.Users.Create
	var _ func(context.Context, string, string, sdk.SessionInput, *sdk.CheckoutSessionsCreateOpts, ...sdk.RequestOption) (*sdk.Session, error) = api.Checkout.Sessions.Create
	var _ func(context.Context, string, sdk.ItemPatch, *sdk.ItemsUpdateOpts, ...sdk.RequestOption) (*sdk.Item, error) = api.Items.Update
	var _ func(context.Context, *sdk.UsersListOpts, ...sdk.RequestOption) (*sdk.UserPage, error) = api.Users.List
	var _ func(context.Context, string, *sdk.GetUserOpts, ...sdk.RequestOption) (*sdk.User, error) = api.GetUser
	var _ func(context.Context, string, *sdk.UsersDeleteOpts, ...sdk.RequestOption) error = api.Users.Delete
	replies["POST /users"] = reply{200, \`{"id":"u1","name":"Ada"}\`}
	replies["DELETE /users/u1"] = reply{204, ""}
	note("created", must(api.Users.Create(ctx, sdk.UserCreateInput{Name: "Ada"}, nil, sdk.WithHeader("X-Trace", "t0"))).Id)
	note("deleted", api.Users.Delete(ctx, "u1", nil) == nil)
	section("opts")
	var _ *int64 = sdk.ItemsUpdateOpts{}.Limit
	fields, trace := "name", "t1"
	must(api.Items.Update(ctx, "i1", sdk.ItemPatch{}, &sdk.ItemsUpdateOpts{Fields: &fields, XTrace: &trace}))
	must(api.Items.Update(ctx, "i1", sdk.ItemPatch{}, &sdk.ItemsUpdateOpts{}))
	must(api.Items.Update(ctx, "i1", sdk.ItemPatch{}, nil))`,
	),
)

const names = once(() =>
	check(
		generateGoSdk(NAMES, { modulePath: "example.com/names" }).files,
		"example.com/names",
		`	api := client("http://api.test")
	section("receivers")
	q, order := "a&b", sdk.StatusCreatedAt2
	must(api.Queue.List(ctx, &sdk.QueueListOpts{Q: &q, Order: &order}))
	must(api.Queue.Get(ctx, "q1", nil))
	section("keywords")
	must(api.Type.Get(ctx, "t1", nil))
	must(api.Select.Range(ctx, "u1", "c1", nil))
	section("models")
	replies["GET /config"] = reply{200, \`{"region":"eu"}\`}
	var model *sdk.ConfigModel = must(api.Config.Get(ctx, nil))
	note(model.Region)
	section("enums")
	note(sdk.StatusCreatedAt, sdk.StatusCreatedAt2, "["+string(sdk.StatusEmpty)+"]")`,
	),
)

/** A consumer of users.create typed as returning `result`, noting `show` after a 404 and a 200. */
const createUser = (result: string, show: string) => `	api := client("http://api.test")
	var create func(context.Context, sdk.UserCreateInput, *sdk.UsersCreateOpts, ...sdk.RequestOption) (${result}, error) = api.Users.Create
	replies["POST /users"] = reply{404, \`{"message":"no"}\`}
	res, err := create(ctx, sdk.UserCreateInput{Name: "Ada"}, nil)
	note(${show})
	replies["POST /users"] = reply{200, \`{"id":"u1","name":"Ada"}\`}
	res, err = create(ctx, sdk.UserCreateInput{Name: "Ada"}, nil)
	note(${show})`

/** One users.create operation, no server; and the same API serving at a base path. */
const USERS_DOC = document(
	{ "/users": { post: op("users.create", { body: ref("UserCreateInput"), ok: ref("User") }) } },
	USERS,
)
const SERVED = { ...USERS_DOC, servers: [{ url: "https://api.example.test/v1" }] }

/** `doc`'s SDK as example.com/users, throwing by default. */
const usersSdk = (doc: Json, throwOnError?: boolean) =>
	generateGoSdk(doc, { modulePath: "example.com/users", throwOnError }).files

/* Go absent passes locally and fails where it is required (CI, the pre-push battery) */
const go = hasGo()

/** Whether this test runs its Go half: false only where Go may be absent. */
function withGo(): boolean {
	expect(go || !goRequired()).toBe(true)
	return go
}

describe("the Go SDK surface, called from a consumer program", () => {
	// v0: 5333bd1243
	// v0: 48146cd2d8
	// v0: 5e3a5b2c03
	// v0: 9e012d9092
	it("reaches each operation by its dotted id on NewClient's client, a bare id on the client itself", () => {
		if (!withGo()) return
		const run = shop()
		expect(seen(run, "tree"), run.stderr).toEqual({
			built: true,
			out: [
				'POST http://api.test/users {"name":"Ada"}',
				"GET http://api.test/users",
				"GET http://api.test/users/u1/profile",
				'POST http://api.test/checkout/o1/sessions/s1 {"amount":5}',
				"GET http://api.test/users/u1",
			],
			vet: [],
		})
	}, 600_000)

	// v0: 031c04034a
	it("takes ctx, the path params in path order, the typed body, *Opts and RequestOptions; no response body is error alone", () => {
		if (!withGo()) return
		const run = shop()
		expect(seen(run, "signature"), run.stderr).toEqual({
			built: true,
			out: [
				'POST http://api.test/users x-trace=t0 {"name":"Ada"}',
				"created u1",
				"DELETE http://api.test/users/u1",
				"deleted true",
			],
			vet: [],
		})
	}, 600_000)

	// v0: 162e732651
	it("carries query and header params on <Op>Opts as pointers, sending only the ones set", () => {
		if (!withGo()) return
		const run = shop()
		expect(seen(run, "opts"), run.stderr).toEqual({
			built: true,
			out: [
				"PATCH http://api.test/items/i1?fields=name x-trace=t1 {}",
				"PATCH http://api.test/items/i1 {}",
				"PATCH http://api.test/items/i1 {}",
			],
			vet: [],
		})
	}, 600_000)
})

describe("throwOnError, chosen at generation", () => {
	// v0: 4fd09131bd
	it("returns (*T, error) by default and (SDKResult[T], error) with throwOnError false", () => {
		if (!withGo()) return
		const thrown = check(
			usersSdk(USERS_DOC),
			"example.com/users",
			createUser("*sdk.User", 'res == nil, err != nil, res != nil && res.Name == "Ada"'),
		)
		const safe = check(
			usersSdk(USERS_DOC, false),
			"example.com/users",
			createUser("sdk.SDKResult[sdk.User]", "res.OK(), res.Status, err == nil, res.Data != nil"),
		)
		expect({ safe: seen(safe), thrown: seen(thrown) }, thrown.stderr + safe.stderr).toEqual({
			safe: {
				built: true,
				out: [
					'POST http://api.test/users {"name":"Ada"}',
					"false 404 true false",
					'POST http://api.test/users {"name":"Ada"}',
					"true 200 true true",
				],
				vet: [],
			},
			thrown: {
				built: true,
				out: [
					'POST http://api.test/users {"name":"Ada"}',
					"true true false",
					'POST http://api.test/users {"name":"Ada"}',
					"false false true",
				],
				vet: [],
			},
		})
	}, 600_000)
})

describe("NewClient's BaseURL", () => {
	it("defaults an empty BaseURL to the document's first server, and without either fails at NewClient", () => {
		if (!withGo()) return
		const defaulted = check(
			usersSdk(SERVED),
			"example.com/users",
			`	must(sdk.NewClient(sdk.Config{HTTPClient: transport}).Users.Create(ctx, sdk.UserCreateInput{Name: "Ada"}, nil))
	must(client("http://other.test").Users.Create(ctx, sdk.UserCreateInput{Name: "Ada"}, nil))`,
		)
		const refused = check(
			usersSdk(USERS_DOC),
			"example.com/users",
			`	construct := func(cfg sdk.Config) (failure string) {
		defer func() { failure = fmt.Sprint(recover()) }()
		sdk.NewClient(cfg)
		return ""
	}
	note(construct(sdk.Config{}))
	note(construct(sdk.Config{BaseURL: "http://api.test"}))`,
		)
		expect({ defaulted: seen(defaulted), refused: seen(refused) }, defaulted.stderr + refused.stderr).toEqual({
			defaulted: {
				built: true,
				out: ['POST https://api.example.test/v1/users {"name":"Ada"}', 'POST http://other.test/users {"name":"Ada"}'],
				vet: [],
			},
			refused: { built: true, out: [expect.stringMatching(/BaseURL/), "<nil>"], vet: [] },
		})
	}, 600_000)
})

describe("Go names that never collide, called from a consumer program", () => {
	// v0: d38a66c936
	it("keeps a receiver apart from a param named like it: queue with a q query and a q path param", () => {
		if (!withGo()) return
		const run = names()
		expect(seen(run, "receivers"), run.stderr).toEqual({
			built: true,
			out: ["GET http://api.test/queue?order=created_at&q=a%26b", "GET http://api.test/queue/q1"],
			vet: [],
		})
	}, 600_000)

	// v0: 6c7134e410
	it("exports resources and actions named like Go keywords, with keyword and package-named path params", () => {
		if (!withGo()) return
		const run = names()
		expect(seen(run, "keywords"), run.stderr).toEqual({
			built: true,
			out: ["GET http://api.test/type/t1", "GET http://api.test/select/u1/c1"],
			vet: [],
		})
	}, 600_000)

	// v0: 6e428e7a5a
	it("emits a schema named like a runtime type as <Name>Model, returned by its operation", () => {
		if (!withGo()) return
		const run = names()
		expect(seen(run, "models"), run.stderr).toEqual({ built: true, out: ["GET http://api.test/config", "eu"], vet: [] })
	}, 600_000)

	// v0: 784a6dbdf7
	it("labels enum values with unique exported consts: -created_at, created_at and the empty string", () => {
		if (!withGo()) return
		const run = names()
		expect(seen(run, "enums"), run.stderr).toEqual({ built: true, out: ["-created_at created_at []"], vet: [] })
	}, 600_000)
})
