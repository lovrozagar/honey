/* Cross-language SDK runtime conformance.
 *
 * 1. Every runtime (Go, Python, Rust) runs the shared vectors in tests/conformance/vectors/
 *    (url-building.json, sse.json) — the same files the TypeScript client runs: path
 *    templates (escaping, "", ".", ".." rejected), URL building (base path and base query kept),
 *    query serialization and the WHATWG SSE parser.
 * 2. Each generated SDK — Go, Python, Rust, the generated TypeScript SDK — and the TypeScript
 *    `createClient` send the same operation to one capture server; method, path, query and the
 *    selected headers must be byte-identical, and the JSON body equal.
 */

import { spawn, spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { createClient } from "../../../src/client/index.ts"
import { generateSDK } from "../../../src/codegen.ts"
import { generateGoSDK } from "../../../src/codegen-go.ts"
import { generatePythonSDK } from "../../../src/codegen-python.ts"
import { generateRustSDK } from "../../../src/codegen-rust.ts"
import { CARGO_TARGET_DIR } from "../../cargo-env.ts"
import { PYTHON } from "../../python-env.ts"

const URL_VECTORS = fileURLToPath(new URL("../../conformance/vectors/url-building.json", import.meta.url))
const SSE_VECTORS = fileURLToPath(new URL("../../conformance/vectors/sse.json", import.meta.url))
const urlVectors = (
	JSON.parse(readFileSync(URL_VECTORS, "utf8")) as {
		vectors: Array<{ name: string; expect?: string; error?: string }>
	}
).vectors
const sseVectors = (
	JSON.parse(readFileSync(SSE_VECTORS, "utf8")) as {
		vectors: Array<{ name: string; events: Array<{ data: string; event?: string; id?: string; retry?: number }> }>
	}
).vectors

/** Each runner prints `{ url: [{ ok, value }], sse: [{ ok, events | error }] }`. */
type Results = {
	url: Array<{ ok: boolean; value: string }>
	sse: Array<{ ok: boolean; events?: Array<Record<string, unknown>>; error?: string }>
}

function has(cmd: string, args: string[]): boolean {
	return spawnSync(cmd, args, { stdio: "ignore" }).status === 0
}
const hasGo = has("go", ["version"])
const hasCargo = has("cargo", ["--version"])
const hasPython = has(PYTHON, ["-c", "import httpx"])

const OFFLINE = /dial tcp|no such host|Could not resolve|failed to download|network|timed out|proxy\.golang\.org/i

function writeTree(root: string, files: Record<string, string>): void {
	for (const [rel, content] of Object.entries(files)) {
		const p = join(root, rel)
		mkdirSync(dirname(p), { recursive: true })
		writeFileSync(p, content, "utf8")
	}
}

/** Async: the capture server runs in this process, so the event loop must stay free. */
function run(
	cmd: string,
	args: string[],
	cwd: string,
	env: NodeJS.ProcessEnv = process.env,
): Promise<{ ok: boolean; out: string; err: string }> {
	return new Promise((resolve) => {
		const child = spawn(cmd, args, { cwd, env })
		let out = ""
		let err = ""
		child.stdout.on("data", (c: Buffer) => {
			out += c.toString("utf8")
		})
		child.stderr.on("data", (c: Buffer) => {
			err += c.toString("utf8")
		})
		const timer = setTimeout(() => child.kill("SIGKILL"), 600_000)
		child.on("close", (code) => {
			clearTimeout(timer)
			resolve({ err, ok: code === 0, out })
		})
	})
}

/* ── the operation every SDK sends to the capture server ── */

const conformanceSpec = {
	components: {
		schemas: {
			Item: {
				properties: { n: { type: "integer" }, name: { type: "string" } },
				required: ["name"],
				type: "object",
			},
		},
	},
	info: { title: "Conformance", version: "1.0.0" },
	openapi: "3.1.0",
	paths: {
		"/items/{id}": {
			put: {
				operationId: "items.update",
				parameters: [
					{ in: "path", name: "id", required: true, schema: { type: "string" } },
					{ in: "query", name: "tags", schema: { items: { type: "string" }, type: "array" } },
					{ in: "query", name: "limit", schema: { type: "integer" } },
					{ in: "query", name: "ratio", schema: { type: "number" } },
					{ in: "query", name: "flag", schema: { type: "boolean" } },
					{ in: "query", name: "q", schema: { type: "string" } },
					{ in: "header", name: "x-trace", schema: { type: "string" } },
				],
				requestBody: {
					content: { "application/json": { schema: { $ref: "#/components/schemas/Item" } } },
					required: true,
				},
				responses: {
					"200": {
						content: { "application/json": { schema: { $ref: "#/components/schemas/Item" } } },
						description: "ok",
					},
				},
			},
		},
	},
}

const EXPECTED_REQUEST = {
	authorization: "Bearer tok",
	body: { n: 2, name: "n" },
	contentType: "application/json",
	method: "PUT",
	url: "/v1/items/a%20b%2F%C3%BC?flag=true&limit=3&q=h%C3%A9%26llo&ratio=0.5&tags=x&tags=y+z",
	xTrace: "t1",
}

type Captured = {
	method: string
	url: string
	authorization: string
	contentType: string
	xTrace: string
	body: unknown
}

const captured = new Map<string, Captured>()
let port = 0
const server = createServer((req, res) => {
	const chunks: Buffer[] = []
	req.on("data", (c: Buffer) => chunks.push(c))
	req.on("end", () => {
		const lang = String(req.headers["x-lang"] ?? "unknown")
		const raw = Buffer.concat(chunks).toString("utf8")
		captured.set(lang, {
			authorization: String(req.headers.authorization ?? ""),
			body: raw ? JSON.parse(raw) : null,
			contentType: String(req.headers["content-type"] ?? ""),
			method: String(req.method),
			url: String(req.url),
			xTrace: String(req.headers["x-trace"] ?? ""),
		})
		res.writeHead(200, { "content-type": "application/json" })
		res.end(JSON.stringify({ n: 2, name: "n" }))
	})
})

beforeAll(async () => {
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
	port = (server.address() as AddressInfo).port
})

afterAll(async () => {
	await new Promise<void>((resolve) => server.close(() => resolve()))
})

function expectVectors(results: Results): void {
	urlVectors.forEach((v, i) => {
		const got = results.url[i]
		if (v.error !== undefined) {
			expect(got.ok, `url: ${v.name} should fail`).toBe(false)
			expect(got.value, `url: ${v.name}`).toContain(v.error)
		} else {
			expect(got, `url: ${v.name}`).toEqual({ ok: true, value: v.expect })
		}
	})
	sseVectors.forEach((v, i) => {
		expect(results.sse[i], `sse: ${v.name}`).toEqual({ events: v.events, ok: true })
	})
}

/* ── Go ── */

const GO_MAIN = `package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"strconv"

	sdk "example.com/confsdk"
)

type urlVector struct {
	Base   string            \`json:"base"\`
	Path   string            \`json:"path"\`
	Params map[string]string \`json:"params"\`
	Search json.RawMessage   \`json:"search"\`
}

type sseVector struct {
	Chunks []json.RawMessage \`json:"chunks"\`
}

func scalar(v any) string {
	if n, ok := v.(json.Number); ok {
		f, _ := strconv.ParseFloat(string(n), 64)
		return sdk.HoneyFormatQueryValue(f)
	}
	return sdk.HoneyFormatQueryValue(v)
}

/* search keeps its JSON key order */
func pairs(raw json.RawMessage) [][2]string {
	out := [][2]string{}
	if len(raw) == 0 {
		return out
	}
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	_, _ = dec.Token()
	for dec.More() {
		tok, _ := dec.Token()
		key := tok.(string)
		var v any
		_ = dec.Decode(&v)
		switch t := v.(type) {
		case nil:
		case []any:
			for _, item := range t {
				if item != nil {
					out = append(out, [2]string{key, scalar(item)})
				}
			}
		default:
			out = append(out, [2]string{key, scalar(t)})
		}
	}
	return out
}

func main() {
	var urls struct{ Vectors []urlVector \`json:"vectors"\` }
	var sses struct{ Vectors []sseVector \`json:"vectors"\` }
	raw, _ := os.ReadFile(os.Args[1])
	if err := json.Unmarshal(raw, &urls); err != nil {
		panic(err)
	}
	raw, _ = os.ReadFile(os.Args[2])
	if err := json.Unmarshal(raw, &sses); err != nil {
		panic(err)
	}
	out := map[string]any{}
	urlOut := []map[string]any{}
	for _, v := range urls.Vectors {
		params := v.Params
		if params == nil {
			params = map[string]string{}
		}
		path, err := sdk.HoneyExpandPath(v.Path, params)
		if err == nil {
			var full string
			full, err = sdk.HoneyBuildURL(v.Base, path, pairs(v.Search))
			if err == nil {
				urlOut = append(urlOut, map[string]any{"ok": true, "value": full})
				continue
			}
		}
		urlOut = append(urlOut, map[string]any{"ok": false, "value": err.Error()})
	}
	out["url"] = urlOut
	sseOut := []map[string]any{}
	for _, v := range sses.Vectors {
		readers := []io.Reader{}
		for _, c := range v.Chunks {
			var text string
			if json.Unmarshal(c, &text) == nil {
				readers = append(readers, bytes.NewReader([]byte(text)))
				continue
			}
			var b struct{ Bytes []int \`json:"bytes"\` }
			_ = json.Unmarshal(c, &b)
			buf := make([]byte, len(b.Bytes))
			for i, x := range b.Bytes {
				buf[i] = byte(x)
			}
			readers = append(readers, bytes.NewReader(buf))
		}
		resp := &http.Response{StatusCode: 200, Body: io.NopCloser(io.MultiReader(readers...))}
		events := []map[string]any{}
		var failed error
		for ev, err := range sdk.HoneyParseSSEStream(context.Background(), resp) {
			if err != nil {
				failed = err
				break
			}
			e := map[string]any{"data": ev.Data}
			if ev.Event != "" {
				e["event"] = ev.Event
			}
			if ev.ID != "" {
				e["id"] = ev.ID
			}
			if ev.Retry > 0 {
				e["retry"] = ev.Retry
			}
			events = append(events, e)
		}
		if failed != nil {
			sseOut = append(sseOut, map[string]any{"ok": false, "error": failed.Error()})
		} else {
			sseOut = append(sseOut, map[string]any{"ok": true, "events": events})
		}
	}
	out["sse"] = sseOut

	client := sdk.NewClient(sdk.Config{BaseURL: os.Args[3], BearerToken: "tok", Headers: map[string]string{"x-lang": "go"}})
	ptrS := func(v string) *string { return &v }
	ptrI := func(v int64) *int64 { return &v }
	ptrF := func(v float64) *float64 { return &v }
	ptrB := func(v bool) *bool { return &v }
	_, err := client.Items.Update(context.Background(), "a b/ü", sdk.Item{Name: "n", N: ptrI(2)}, &sdk.ItemsUpdateOpts{
		Tags:   []string{"x", "y z"},
		Limit:  ptrI(3),
		Ratio:  ptrF(0.5),
		Flag:   ptrB(true),
		Q:      ptrS("hé&llo"),
		XTrace: ptrS("t1"),
	})
	if err != nil {
		panic(err)
	}
	enc, _ := json.Marshal(out)
	fmt.Println(string(enc))
}
`

describe.skipIf(!hasGo)("conformance — Go runtime", () => {
	it("runs the shared vectors and sends the reference request", async (ctx) => {
		const dir = mkdtempSync(join(tmpdir(), "honey-conf-go-"))
		try {
			writeTree(join(dir, "sdk"), generateGoSDK(conformanceSpec, { modulePath: "example.com/confsdk" }).files)
			writeFileSync(
				join(dir, "go.mod"),
				`module example.com/confrun\n\ngo 1.24\n\nrequire example.com/confsdk v0.0.0\n\nreplace example.com/confsdk => ./sdk\n`,
			)
			writeFileSync(join(dir, "main.go"), GO_MAIN)
			const tidy = await run("go", ["mod", "tidy"], dir)
			if (!tidy.ok && OFFLINE.test(tidy.err)) ctx.skip()
			expect(tidy.ok, tidy.err).toBe(true)
			const r = await run("go", ["run", ".", URL_VECTORS, SSE_VECTORS, `http://127.0.0.1:${port}/v1`], dir)
			expect(r.ok, r.err).toBe(true)
			expectVectors(JSON.parse(r.out) as Results)
			const { body, ...rest } = captured.get("go") as Captured
			const { body: wantBody, ...wantRest } = EXPECTED_REQUEST
			expect(rest).toEqual(wantRest)
			expect(body).toEqual(wantBody)
		} finally {
			rmSync(dir, { force: true, recursive: true })
		}
	}, 600_000)
})

/* ── Python ── */

const PY_MAIN = `
import asyncio, json, sys
sys.path.insert(0, ".")
from confsdk._runtime import _expand_path, _build_url, ClientConfig
from confsdk._sse import SSEParser
from confsdk.client import AsyncSDK

urls = json.load(open(sys.argv[1], encoding="utf-8"))["vectors"]
sses = json.load(open(sys.argv[2], encoding="utf-8"))["vectors"]
out = {"url": [], "sse": []}
for v in urls:
    try:
        path = _expand_path(v["path"], v.get("params") or {})
        out["url"].append({"ok": True, "value": _build_url(v["base"], path, v.get("search"))})
    except ValueError as exc:
        out["url"].append({"ok": False, "value": str(exc)})
for v in sses:
    parser = SSEParser()
    events = []
    try:
        for c in v["chunks"]:
            data = c.encode("utf-8") if isinstance(c, str) else bytes(c["bytes"])
            events.extend(parser.feed(data))
        norm = []
        for e in events:
            n = {"data": e.get("data", "")}
            if e.get("event"):
                n["event"] = e["event"]
            if e.get("id"):
                n["id"] = e["id"]
            if e.get("retry"):
                n["retry"] = e["retry"]
            norm.append(n)
        out["sse"].append({"ok": True, "events": norm})
    except Exception as exc:
        out["sse"].append({"ok": False, "error": str(exc)})

async def main():
    sdk = AsyncSDK(ClientConfig(base_url=sys.argv[3], bearer_token="tok", headers={"x-lang": "python"}))
    await sdk.items.update("a b/ü", {"name": "n", "n": 2}, tags=["x", "y z"], limit=3, ratio=0.5, flag=True, q="hé&llo", x_trace="t1")
    await sdk.aclose()

asyncio.run(main())
print(json.dumps(out))
`

describe.skipIf(!hasPython)("conformance — Python runtime", () => {
	it("runs the shared vectors and sends the reference request", async () => {
		const dir = mkdtempSync(join(tmpdir(), "honey-conf-py-"))
		try {
			writeTree(join(dir, "confsdk"), generatePythonSDK(conformanceSpec).files)
			writeFileSync(join(dir, "main.py"), PY_MAIN)
			const r = await run(PYTHON, ["main.py", URL_VECTORS, SSE_VECTORS, `http://127.0.0.1:${port}/v1`], dir)
			expect(r.ok, r.err).toBe(true)
			expectVectors(JSON.parse(r.out) as Results)
			const { body, ...rest } = captured.get("python") as Captured
			const { body: wantBody, ...wantRest } = EXPECTED_REQUEST
			expect(rest).toEqual(wantRest)
			expect(body).toEqual(wantBody)
		} finally {
			rmSync(dir, { force: true, recursive: true })
		}
	}, 600_000)
})

/* ── TypeScript: the generated SDK and createClient ── */

function expectReference(lang: string): void {
	const { body, ...rest } = captured.get(lang) as Captured
	const { body: wantBody, ...wantRest } = EXPECTED_REQUEST
	expect(rest).toEqual(wantRest)
	expect(body).toEqual(wantBody)
}

const REFERENCE_SEARCH = { flag: true, limit: 3, q: "hé&llo", ratio: 0.5, tags: ["x", "y z"] }

describe("conformance — TypeScript", () => {
	it("the generated SDK sends the reference request", async () => {
		const { files } = generateSDK(conformanceSpec as never, { name: "ConfSDK", stem: "sdk" })
		const clientBody = files.client.replace(/^import type \{[^\n]+\n/, "").replace(/^import \{[^\n]+\n/, "")
		const { transform } = await import("esbuild")
		const { code } = await transform(`${files.map}\n${clientBody}`, { format: "esm", loader: "ts", target: "esnext" })
		const { ConfSDK } = (await import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`)) as {
			ConfSDK: new (config: Record<string, unknown>) => {
				items: { update(input: Record<string, unknown>): Promise<{ error: unknown }> }
			}
		}
		const sdk = new ConfSDK({
			baseURL: `http://127.0.0.1:${port}/v1`,
			headers: { Authorization: "Bearer tok", "x-lang": "ts-sdk" },
		})
		const result = await sdk.items.update({
			headers: { "x-trace": "t1" },
			json: { n: 2, name: "n" },
			params: { id: "a b/ü" },
			search: REFERENCE_SEARCH,
		})
		expect(result.error).toBeNull()
		expectReference("ts-sdk")
	})

	it("createClient sends the reference request", async () => {
		const client = createClient({
			baseURL: `http://127.0.0.1:${port}/v1`,
			headers: { Authorization: "Bearer tok", "x-lang": "ts-client" },
		}) as unknown as Record<string, (path: string, input: Record<string, unknown>) => Promise<{ error: unknown }>>
		const result = await client.put("/items/:id", {
			headers: { "x-trace": "t1" },
			json: { n: 2, name: "n" },
			params: { id: "a b/ü" },
			search: REFERENCE_SEARCH,
		})
		expect(result.error).toBeNull()
		expectReference("ts-client")
	})
})

/* ── Rust ── */

const RUST_MAIN = `use std::collections::HashMap;
use confsdk::runtime::{build_url, expand_path, QueryValue};
use confsdk::sse::SseParser;
use confsdk::{Client, ClientConfig};
use confsdk::types::Item;
use confsdk::resources::items::ItemsUpdateOpts;
use serde_json::{json, Value};

#[tokio::main]
async fn main() {
    let args: Vec<String> = std::env::args().collect();
    let urls: Value = serde_json::from_str(&std::fs::read_to_string(&args[1]).unwrap()).unwrap();
    let sses: Value = serde_json::from_str(&std::fs::read_to_string(&args[2]).unwrap()).unwrap();

    let mut url_out = Vec::new();
    for v in urls["vectors"].as_array().unwrap() {
        let params: Vec<(String, String)> = v["params"].as_object().map(|m| m.iter().map(|(k, x)| (k.clone(), x.as_str().unwrap().to_string())).collect()).unwrap_or_default();
        let refs: Vec<(&str, &str)> = params.iter().map(|(k, x)| (k.as_str(), x.as_str())).collect();
        let mut query: Vec<(String, String)> = Vec::new();
        if let Some(m) = v["search"].as_object() {
            for (k, x) in m {
                x.push_query(k, &mut query);
            }
        }
        let res = expand_path(v["path"].as_str().unwrap(), &refs)
            .and_then(|p| build_url(v["base"].as_str().unwrap(), &p, &query));
        url_out.push(match res {
            Ok(u) => json!({"ok": true, "value": u.to_string()}),
            Err(e) => json!({"ok": false, "value": e.to_string()}),
        });
    }

    let mut sse_out = Vec::new();
    for v in sses["vectors"].as_array().unwrap() {
        let mut parser = SseParser::new();
        let mut events = Vec::new();
        let mut failed: Option<String> = None;
        for c in v["chunks"].as_array().unwrap() {
            let bytes: Vec<u8> = match c.as_str() {
                Some(t) => t.as_bytes().to_vec(),
                None => c["bytes"].as_array().unwrap().iter().map(|b| b.as_u64().unwrap() as u8).collect(),
            };
            match parser.feed(&bytes) {
                Ok(evs) => events.extend(evs),
                Err(e) => { failed = Some(e.to_string()); break; }
            }
        }
        sse_out.push(match failed {
            Some(e) => json!({"ok": false, "error": e}),
            None => {
                let norm: Vec<Value> = events.into_iter().map(|e| {
                    let mut m = serde_json::Map::new();
                    m.insert("data".into(), json!(e.data));
                    if !e.event.is_empty() { m.insert("event".into(), json!(e.event)); }
                    if !e.id.is_empty() { m.insert("id".into(), json!(e.id)); }
                    if e.retry > 0 { m.insert("retry".into(), json!(e.retry)); }
                    Value::Object(m)
                }).collect();
                json!({"ok": true, "events": norm})
            }
        });
    }

    let mut headers = HashMap::new();
    headers.insert("x-lang".to_string(), "rust".to_string());
    let client = Client::new(ClientConfig { base_url: args[3].clone(), bearer_token: Some("tok".to_string()), headers, ..Default::default() });
    let opts = ItemsUpdateOpts {
        tags: Some(vec!["x".to_string(), "y z".to_string()]),
        limit: Some(3),
        ratio: Some(0.5),
        flag: Some(true),
        q: Some("hé&llo".to_string()),
        x_trace: Some("t1".to_string()),
        ..Default::default()
    };
    client.items().update("a b/ü", &Item { name: "n".to_string(), n: Some(2) }, &opts).await.unwrap();
    println!("{}", json!({"url": url_out, "sse": sse_out}));
}
`

describe.skipIf(!hasCargo)("conformance — Rust runtime", () => {
	it("runs the shared vectors and sends the reference request", async (ctx) => {
		const dir = mkdtempSync(join(tmpdir(), "honey-conf-rust-"))
		try {
			writeTree(join(dir, "confsdk"), generateRustSDK(conformanceSpec, { crateName: "confsdk" }).files)
			writeTree(join(dir, "runner"), {
				"Cargo.toml": `[package]\nname = "runner"\nversion = "0.1.0"\nedition = "2021"\n\n[dependencies]\nconfsdk = { path = "../confsdk" }\ntokio = { version = "1", features = ["rt-multi-thread", "macros"] }\nserde_json = { version = "1", features = ["preserve_order", "float_roundtrip"] }\n`,
				"src/main.rs": RUST_MAIN,
			})
			const r = await run(
				"cargo",
				["run", "--quiet", "--", URL_VECTORS, SSE_VECTORS, `http://127.0.0.1:${port}/v1`],
				join(dir, "runner"),
				{
					...process.env,
					CARGO_TARGET_DIR,
				},
			)
			if (!r.ok && OFFLINE.test(r.err) && !/error\[E\d+\]/.test(r.err)) ctx.skip()
			expect(r.ok, r.err).toBe(true)
			expectVectors(JSON.parse(r.out) as Results)
			const { body, ...rest } = captured.get("rust") as Captured
			const { body: wantBody, ...wantRest } = EXPECTED_REQUEST
			expect(rest).toEqual(wantRest)
			expect(body).toEqual(wantBody)
		} finally {
			rmSync(dir, { force: true, recursive: true })
		}
	}, 600_000)
})
