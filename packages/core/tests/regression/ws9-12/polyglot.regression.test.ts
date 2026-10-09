/* Regression tests for the Go, Rust, Python and Go CLI SDKs (workstreams 10 and 11). Each test names
 * its finding and fails on 3ab88ce. Runtime findings run a check program against a mock server in
 * this process, which records every request; compile findings generate an SDK from a minimal
 * document and compile it with the real toolchain (`go vet`, `cargo check`, `compileall`/mypy).
 * The check programs in checks/ use only API shared by both trees, so one build per language and
 * tree serves every runtime check. A missing toolchain skips its language. Opt-in: test:harness. */

import { spawn, spawnSync } from "node:child_process"
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { createServer, type IncomingMessage, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { generateGoCLI } from "../../../src/codegen-go-cli.ts"
import { generateGoSDK } from "../../../src/codegen-go.ts"
import { generatePythonSDK } from "../../../src/codegen-python.ts"
import { generateRustSDK } from "../../../src/codegen-rust.ts"
import { CARGO_TARGET_DIR } from "../../cargo-env.ts"
import {
	cliRuntimeSpec,
	doc,
	goRuntimeSpec,
	jsonBody,
	jsonOk,
	pathParam,
	pythonRuntimeSpec,
	queryParam,
	rustRuntimeSpec,
	sseOk,
} from "./polyglot-specs.ts"

const CHECKS = join(import.meta.dirname, "checks")
const PY = process.env.HONEY_PYTHON ?? "python3"

function has(cmd: string, args: string[]): boolean {
	return spawnSync(cmd, args, { stdio: "ignore" }).status === 0
}
const hasGo = has("go", ["version"])
const hasCargo = has("cargo", ["--version"])
const hasPython = has(PY, ["-c", "import httpx"])
const hasMypy = hasPython && has(PY, ["-m", "mypy", "--version"])

function writeTree(root: string, files: Record<string, string>): void {
	for (const [rel, content] of Object.entries(files)) {
		const p = join(root, rel)
		mkdirSync(dirname(p), { recursive: true })
		writeFileSync(p, content, "utf8")
	}
}

type Run = { code: number | null; out: string; err: string }

/** Async so the mock server in this process keeps answering while the child runs. */
function run(cmd: string, args: string[], cwd: string, env: NodeJS.ProcessEnv = {}, timeoutMs = 600_000): Promise<Run> {
	return new Promise((done) => {
		const child = spawn(cmd, args, { cwd, env: { ...process.env, ...env } })
		let out = ""
		let err = ""
		child.stdout.on("data", (d: Buffer) => (out += d.toString()))
		child.stderr.on("data", (d: Buffer) => (err += d.toString()))
		const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs)
		child.on("close", (code) => {
			clearTimeout(timer)
			done({ code, err, out })
		})
	})
}

function reported(r: Run): Record<string, unknown> {
	const line = r.out.split("\n").findLast((l) => l.startsWith("REGRESS "))
	if (!line) throw new Error(`no REGRESS line (exit ${r.code})\n${r.out}\n${r.err}`)
	return JSON.parse(line.slice("REGRESS ".length)) as Record<string, unknown>
}

/* ---- mock server: host A answers, host B is a different origin for redirects ---- */

type Rec = {
	body: string
	headers: IncomingMessage["headers"]
	host: "a" | "b"
	method: string
	raw: string[]
	url: string
}
type Reply = {
	body?: string | Buffer
	chunks?: Array<{ data: string | Buffer; delayMs?: number }>
	delayMs?: number
	headers?: Record<string, string>
	status?: number
}
type Behave = (rec: Rec) => Reply | undefined

let records: Rec[] = []
let behave: Behave = () => undefined
let servers: Server[] = []
let baseA = ""
let baseB = ""

const json = (value: unknown, status = 200): Reply => ({
	body: JSON.stringify(value),
	headers: { "content-type": "application/json" },
	status,
})
const sse = (...chunks: Array<{ data: string | Buffer; delayMs?: number }>): Reply => ({
	chunks,
	headers: { "cache-control": "no-cache", "content-type": "text/event-stream" },
})

function serve(host: "a" | "b"): Promise<Server> {
	const server = createServer((req, res) => {
		const parts: Buffer[] = []
		req.on("data", (c: Buffer) => parts.push(c))
		req.on("end", async () => {
			const rec: Rec = {
				body: Buffer.concat(parts).toString("utf8"),
				headers: req.headers,
				host,
				method: req.method ?? "",
				raw: req.rawHeaders,
				url: req.url ?? "",
			}
			records.push(rec)
			const reply = behave(rec) ?? json({ ok: true })
			if (reply.delayMs) await new Promise((r) => setTimeout(r, reply.delayMs))
			res.writeHead(reply.status ?? 200, reply.headers ?? {})
			if (reply.chunks) {
				for (const c of reply.chunks) {
					if (c.delayMs) await new Promise((r) => setTimeout(r, c.delayMs))
					res.write(c.data)
				}
				res.end()
			} else res.end(reply.body ?? "")
		})
	})
	return new Promise((done) => server.listen(0, "127.0.0.1", () => done(server)))
}

beforeAll(async () => {
	servers = [await serve("a"), await serve("b")]
	baseA = `http://127.0.0.1:${(servers[0].address() as AddressInfo).port}`
	baseB = `http://localhost:${(servers[1].address() as AddressInfo).port}`
})

afterAll(() => {
	for (const s of servers) s.close()
})

function reset(b: Behave = () => undefined): void {
	records = []
	behave = b
}

const count = (rec: Rec, name: string) =>
	rec.raw.filter((_, i) => i % 2 === 0 && rec.raw[i].toLowerCase() === name).length
const on = (method: string, path: string, rec: Rec) => rec.method === method && rec.url.split("?")[0] === path

/** Shared behaviors. `/hop` redirects to the other host; `/users*` answer 401 to a stale token. */
function standard(rec: Rec): Reply | undefined {
	if (rec.url === "/hop") return { headers: { location: `${baseB}/landing` }, status: 307 }
	if (rec.host === "b") return json({ ok: true })
	return undefined
}

function needsToken(token: string): Behave {
	return (rec) => {
		if (rec.url.startsWith("/users") || rec.url.startsWith("/raw")) {
			return rec.headers.authorization === `Bearer ${token}` ? json({ ok: true }) : json({ message: "expired" }, 401)
		}
		return undefined
	}
}

const EVENTS_MIXED = "data: a\r\n\r\ndata: b\n\ndata: partial"

/* ======================================================================================= */
/* Go runtime                                                                              */
/* ======================================================================================= */

describe.skipIf(!hasGo)("Go runtime", () => {
	let dir = ""
	let build: Run = { code: 1, err: "not built", out: "" }

	beforeAll(async () => {
		dir = mkdtempSync(join(tmpdir(), "honey-regress-go-"))
		writeTree(dir, generateGoSDK(goRuntimeSpec, { modulePath: "example.com/sdk" }).files)
		copyFileSync(join(CHECKS, "regress_test.go"), join(dir, "zz_regress_test.go"))
		const tidy = await run("go", ["mod", "tidy"], dir)
		build = tidy.code === 0 ? await run("go", ["test", "-c", "-p", "4", "-o", "regress.test", "."], dir) : tidy
	}, 600_000)

	afterAll(() => rmSync(dir, { force: true, recursive: true }))

	async function goCheck(name: string, b: Behave = () => undefined): Promise<Record<string, unknown>> {
		expect(build.code, `${build.out}\n${build.err}`).toBe(0)
		reset((rec) => b(rec) ?? standard(rec))
		const r = await run(
			join(dir, "regress.test"),
			["-test.run", `^${name}$`, "-test.v"],
			dir,
			{ REGRESS_BASE: baseA },
			60_000,
		)
		expect(r.code, `${r.out}\n${r.err}`).toBe(0)
		return reported(r)
	}

	it("H56: the base URL's path is kept", async () => {
		await goCheck("TestH56BasePathKept")
		expect(records.map((r) => r.url)).toEqual(["/api/users/1"])
	})

	it("M (codegen-go.ts:133): `..`, `.` and empty path params are refused before sending", async () => {
		const out = await goCheck("TestDotSegmentParams")
		expect(records).toEqual([])
		expect((out.errs as string[]).every((e) => e !== "")).toBe(true)
	})

	it("H42: an SSE operation on POST sends its method, body and auth", async () => {
		const out = await goCheck("TestH42SseSendsMethodBodyAuth", (rec) =>
			rec.url.startsWith("/chat") ? sse({ data: "data: one\n\n" }) : undefined,
		)
		const chat = records.find((r) => r.url.startsWith("/chat"))
		expect(chat?.method).toBe("POST")
		expect(chat?.body).toContain("hi")
		expect(chat?.headers.authorization).toBe("Bearer tok")
		expect(out.data).toEqual(["one"])
	})

	it("H50: an urlencoded body is sent", async () => {
		await goCheck("TestH50FormBody")
		const rec = records.find((r) => r.url === "/form")
		expect(rec?.headers["content-type"]).toMatch(/application\/x-www-form-urlencoded/)
		expect(rec?.body).toContain("form-value")
	})

	it("H50: a multipart body is sent", async () => {
		await goCheck("TestH50MultipartBody")
		const rec = records.find((r) => r.url === "/upload")
		expect(rec?.headers["content-type"]).toMatch(/multipart\/form-data/)
		expect(rec?.body).toContain("multipart-value")
	})

	it("M (go-type-emitter.ts:315-323): a discriminated union keeps its variant's data", async () => {
		const out = await goCheck("TestUnionKeepsVariantData", (rec) =>
			rec.url === "/union" ? json({ kind: "circle", radius: 2.5 }) : undefined,
		)
		expect(out.err).toBe("")
		expect(out.value).toContain("2.5")
	})

	it("M (go-type-emitter.ts:363-388): additionalProperties beside fields survive decoding", async () => {
		const out = await goCheck("TestAdditionalPropertiesKept", (rec) =>
			rec.url === "/extra" ? json({ color: "red", name: "x" }) : undefined,
		)
		expect(out.err).toBe("")
		expect(out.value).toContain("red")
	})

	it("M (codegen-go.ts:148-152): a text/plain 2xx body is not JSON-decoded", async () => {
		const out = await goCheck("TestTextBodyNotJSONDecoded", (rec) =>
			rec.url === "/text" ? { body: "hello", headers: { "content-type": "text/plain" } } : undefined,
		)
		expect(out.err).toBe("")
		expect(out.value).toContain("hello")
	})

	it("H62: a 401 never makes a raw upload go out again with an empty body", async () => {
		await goCheck("TestH62RawUploadNeverResentEmpty", needsToken("new"))
		const posts = records.filter((r) => on("POST", "/raw", r))
		expect(posts.length).toBeGreaterThan(0)
		expect(posts.map((r) => r.body)).toEqual(posts.map(() => "raw-retry-body"))
	})

	it("L (client-go/runtime.go:167-176): the refreshed token is kept for later calls", async () => {
		const out = await goCheck("TestH62AuthRetryResendsBody", needsToken("new"))
		expect(records.filter((r) => on("GET", "/users/1", r))).toHaveLength(1)
		expect(out.refreshes).toBe(1)
	})

	it("M (client-go/runtime.go:270,362-372): custom headers never follow a redirect to another host", async () => {
		await goCheck("TestCrossHostRedirectDropsHeaders")
		const leaked = records.filter((r) => r.host === "b" && r.headers["x-api-key"] !== undefined)
		expect(leaked).toEqual([])
	})

	it("M (client-go/runtime.go:55): Config.Timeout bounds a call", async () => {
		const out = await goCheck("TestConfigTimeoutHonored", (rec) =>
			rec.url === "/slow" ? { ...json({ ok: true }), delayMs: 2_000 } : undefined,
		)
		expect(out.err).not.toBe("")
		expect(out.ms as number).toBeLessThan(1_500)
	})

	it("M (client-go/invalidation.go:103-124): a param-less mutation marks the templated read stale, and a read clears it", async () => {
		const out = await goCheck("TestParamlessMutationMarksPattern")
		expect(out.stale).toEqual([false, true, false])
	})

	it("L (client-go/sse.go:70-90): mixed line endings split events and a truncated final event is dropped", async () => {
		const out = await goCheck("TestSseLineEndingsAndPartialEvent", (rec) =>
			rec.url === "/events" ? sse({ data: EVENTS_MIXED }) : undefined,
		)
		expect(out.data).toEqual(["a", "b"])
	})
})

/* ======================================================================================= */
/* Python runtime                                                                          */
/* ======================================================================================= */

describe.skipIf(!hasPython)("Python runtime", () => {
	let dir = ""

	beforeAll(() => {
		dir = mkdtempSync(join(tmpdir(), "honey-regress-py-"))
		writeTree(join(dir, "sdk"), generatePythonSDK(pythonRuntimeSpec).files)
		copyFileSync(join(CHECKS, "regress_check.py"), join(dir, "regress_check.py"))
	})

	afterAll(() => rmSync(dir, { force: true, recursive: true }))

	async function pyCheck(name: string, b: Behave = () => undefined): Promise<Record<string, unknown>> {
		reset((rec) => b(rec) ?? standard(rec))
		const r = await run(PY, ["regress_check.py", name], dir, { REGRESS_BASE: baseA }, 60_000)
		expect(r.code, `${r.out}\n${r.err}`).toBe(0)
		return reported(r)
	}

	it("H55: SSE splits lines only on CR and LF, never on U+2028", async () => {
		const out = await pyCheck("h55_sse_unicode_separators", (rec) =>
			rec.url === "/events" ? sse({ data: 'data: {"t":"a\u2028b"}\n\n' }) : undefined,
		)
		expect(out.data).toEqual(['{"t":"a\u2028b"}'])
	})

	it("NEW (H, codegen-python.ts:399): `..`, `.` and empty path params are refused before sending", async () => {
		const out = await pyCheck("dot_segment_params")
		expect(records).toEqual([])
		expect((out.errs as string[]).every((e) => e !== "")).toBe(true)
	})

	it("H50: an urlencoded body is sent", async () => {
		const out = await pyCheck("h50_form_body")
		expect(out.err).toBe("")
		expect(records.find((r) => r.url === "/form")?.body).toContain("form-value")
	})

	/* httpx 0.28 cannot encode a list of `data` tuples beside `files`: text fields travel as
	 * `(None, value)` file parts instead. */
	it("H50: a multipart body is sent", async () => {
		const out = await pyCheck("h50_multipart_body")
		expect(out.err).toBe("")
		const rec = records.find((r) => r.url === "/upload")
		expect(rec?.headers["content-type"]).toMatch(/multipart\/form-data/)
		expect(rec?.body).toContain("multipart-value")
		expect(rec?.body).toContain("file-bytes")
	})

	// regression: R8
	it.fails("R8: a multipart operation called with no fields still sends an empty multipart body", async () => {
		const out = await pyCheck("r8_empty_multipart_body")
		expect(out.err).toBe("")
		const rec = records.find((r) => r.url === "/upload")
		const type = rec?.headers["content-type"] ?? ""
		expect(type).toMatch(/^multipart\/form-data; boundary=/)
		const boundary = type.split("boundary=")[1] ?? ""
		expect(rec?.body).toBe(`--${boundary}--\r\n`)
	})

	it("H42: an SSE operation on POST sends its JSON body", async () => {
		const out = await pyCheck("h42_sse_post_body", (rec) =>
			rec.url.startsWith("/chat") ? sse({ data: "data: one\n\n" }) : undefined,
		)
		const chat = records.find((r) => r.url.startsWith("/chat"))
		expect(chat?.method).toBe("POST")
		expect(chat?.body).toContain("hi")
		expect(out.data).toEqual(["one"])
	})

	it("H60: an SSE stream outlives the default read timeout", async () => {
		const out = await pyCheck("h60_sse_outlives_read_timeout", (rec) =>
			rec.url === "/events" ? sse({ data: "data: 1\n\n" }, { data: "data: 2\n\n", delayMs: 6_000 }) : undefined,
		)
		expect(out.err).toBe("")
		expect(out.data).toEqual(["1", "2"])
	}, 30_000)

	it("H62: the 401-refresh retry resends a raw upload body", async () => {
		const out = await pyCheck("h62_auth_retry_resends_raw_body", needsToken("new"))
		const posts = records.filter((r) => on("POST", "/raw", r))
		expect(posts).toHaveLength(2)
		expect(posts[1].body).toBe("raw-retry-body")
		expect(out.first).toBe("")
	})

	it("L (client-python/_runtime.py:256-292): the refreshed token is kept for later calls", async () => {
		const out = await pyCheck("h62_auth_retry_resends_raw_body", needsToken("new"))
		expect(records.filter((r) => on("GET", "/users/1", r))).toHaveLength(1)
		expect(out.refreshes).toBe(1)
	})

	it("M (client-python/_runtime.py:159-161): a 3xx response raises instead of returning success", async () => {
		const out = await pyCheck("redirect_is_an_error", (rec) =>
			rec.url === "/hop" ? { headers: { location: "/landing" }, status: 302 } : undefined,
		)
		expect(out.err).not.toBe("")
	})

	it("M (client-python/_runtime.py:149-156): a binary body is returned as bytes", async () => {
		const out = await pyCheck("binary_body_is_bytes", (rec) =>
			rec.url === "/bin"
				? { body: Buffer.from([0x00, 0xff, 0x80]), headers: { "content-type": "application/octet-stream" } }
				: undefined,
		)
		expect(out).toEqual({ hex: "00ff80", type: "bytes" })
	})

	it("M (client-python/_runtime.py:385-392): a sync on_auth_expired hook refreshes inside a running loop", async () => {
		const out = await pyCheck("sync_refresh_hook", needsToken("new"))
		expect(out.err).toBe("")
		expect(records.at(-1)?.headers.authorization).toBe("Bearer new")
	})

	it("M (client-python/_invalidation.py:76-101): a param-less mutation marks the templated read stale", async () => {
		const out = await pyCheck("paramless_mutation_marks_pattern")
		expect((out.stale as boolean[]).slice(0, 2)).toEqual([false, true])
	})

	it("L (client-python/_invalidation.py:17,53-69): an `{id}:action` path is interpolated", async () => {
		const out = await pyCheck("colon_action_path")
		expect(out.err).toBe("")
		expect(records.map((r) => r.url)).toEqual(["/ops/7:cancel"])
	})

	it("L (client-python/_runtime.py:116-135): header names merge case-insensitively", async () => {
		await pyCheck("one_authorization_header")
		expect(count(records[0], "authorization")).toBe(1)
	})
})

/* ======================================================================================= */
/* Rust runtime                                                                            */
/* ======================================================================================= */

describe.skipIf(!hasCargo)("Rust runtime", () => {
	let dir = ""
	let build: Run = { code: 1, err: "not built", out: "" }
	const bin = join(CARGO_TARGET_DIR, "debug", "regress")

	beforeAll(async () => {
		dir = mkdtempSync(join(tmpdir(), "honey-regress-rs-"))
		writeTree(join(dir, "sdk"), generateRustSDK(rustRuntimeSpec, { crateName: "sdk" }).files)
		writeTree(join(dir, "runner"), {
			"Cargo.toml":
				'[package]\nname = "regress"\nversion = "0.1.0"\nedition = "2021"\n\n[dependencies]\nsdk = { path = "../sdk" }\ntokio = { version = "1", features = ["full"] }\nserde = "1"\nserde_json = "1"\nfutures-util = "0.3"\n',
		})
		mkdirSync(join(dir, "runner", "src"), { recursive: true })
		copyFileSync(join(CHECKS, "regress_check.rs"), join(dir, "runner", "src", "main.rs"))
		build = await run("cargo", ["build", "-j", "4", "--quiet"], join(dir, "runner"), { CARGO_TARGET_DIR })
	}, 900_000)

	afterAll(() => rmSync(dir, { force: true, recursive: true }))

	async function rsCheck(name: string, b: Behave = () => undefined): Promise<Record<string, unknown>> {
		expect(build.code, build.err).toBe(0)
		reset((rec) => b(rec) ?? standard(rec))
		const r = await run(bin, [name], dir, { REGRESS_BASE: baseA }, 60_000)
		expect(r.code, `${r.out}\n${r.err}`).toBe(0)
		return reported(r)
	}

	it("H63: connection refused is a transport error, not `Canceled`", async () => {
		const out = await rsCheck("h63_refused_is_not_canceled")
		expect(out.ok).toBe(false)
		expect(out.debug).not.toMatch(/Canceled/)
	})

	it("H56b: the base URL's path is kept", async () => {
		await rsCheck("h56b_base_path_kept")
		expect(records.map((r) => r.url)).toEqual(["/api/users/1"])
	})

	it("M (codegen-rust.ts:1060): `..`, `.` and empty path params are refused before sending", async () => {
		const out = (await rsCheck("dot_segment_params")) as unknown as Array<{ ok: boolean }>
		expect(records).toEqual([])
		expect(out.every((r) => r.ok === false)).toBe(true)
	})

	it("M (runtime.rs:394-406,445-458): headers merge case-insensitively, one Authorization", async () => {
		await rsCheck("one_authorization_header")
		expect(count(records[0], "authorization")).toBe(1)
		expect(count(records[0], "x-both")).toBe(1)
	})

	it("M (runtime.rs:400-406,445-447): custom headers never follow a redirect to another host", async () => {
		await rsCheck("cross_host_redirect")
		expect(records.filter((r) => r.host === "b" && r.headers["x-api-key"] !== undefined)).toEqual([])
	})

	it("M (runtime.rs:285-338): the refreshed token is kept for later calls", async () => {
		const out = await rsCheck("refreshed_token_kept", needsToken("new"))
		expect(records.filter((r) => on("GET", "/users/1", r))).toHaveLength(1)
		expect(out.refreshes).toBe(1)
	})

	it("M (runtime.rs:285-338): concurrent 401s trigger one refresh", async () => {
		const out = await rsCheck("concurrent_401s_refresh_once", needsToken("new"))
		expect(out.refreshes).toBe(1)
	})

	it("M (invalidation.rs:121-146): a param-less mutation marks the templated read stale", async () => {
		const out = await rsCheck("paramless_mutation_marks_pattern")
		expect((out.stale as boolean[]).slice(0, 2)).toEqual([false, true])
	})

	it("L (errors.rs:184): the error message is capped", async () => {
		const out = await rsCheck("error_message_capped", (rec) =>
			rec.url === "/fail"
				? { body: "x".repeat(20_000), headers: { "content-type": "text/plain" }, status: 500 }
				: undefined,
		)
		expect(out.len as number).toBeGreaterThan(0)
		expect(out.len as number).toBeLessThan(2_000)
	})

	it("M (codegen-rust.ts:97-98,845,1004): a text/plain 2xx body is not JSON-decoded", async () => {
		const out = await rsCheck("text_body", (rec) =>
			rec.url === "/text" ? { body: "hello", headers: { "content-type": "text/plain" } } : undefined,
		)
		expect(out.ok).toBe(true)
	})

	it("H41: an SSE operation sends its method, query, body and auth", async () => {
		const out = await rsCheck("h41_sse_post", (rec) =>
			rec.url.startsWith("/chat") ? sse({ data: "data: one\n\n" }) : undefined,
		)
		const chat = records.find((r) => r.url.startsWith("/chat"))
		expect(chat?.method).toBe("POST")
		expect(chat?.url).toBe("/chat?model=m")
		expect(chat?.body).toContain("hi")
		expect(chat?.headers.authorization).toBe("Bearer tok")
		expect(out.events).toEqual(["one"])
	})

	it("M (sse.rs:50-51,66-67,80,110-111): SSE keeps trailing spaces, splits CR-only lines and strips a BOM", async () => {
		const out = await rsCheck("sse_parsing", (rec) =>
			rec.url === "/events" ? sse({ data: "\uFEFFdata: first\n\ndata: tok \n\ndata: cr\r\r" }) : undefined,
		)
		expect(out.data).toEqual(["first", "tok ", "cr"])
	})

	it("M (sse.rs:32-44,79-93): an SSE line has a size cap instead of an unbounded buffer", async () => {
		const chunk = "x".repeat(64 * 1024)
		const out = await rsCheck("sse_line_capped", (rec) =>
			rec.url === "/events"
				? sse({ data: "data: " }, ...Array.from({ length: 48 }, () => ({ data: chunk })), { data: "\n\n" })
				: undefined,
		)
		/* a 3 MiB line is refused, never buffered whole into one event */
		expect(out.largest).toBe(0)
		expect(out.error).not.toBe("")
	}, 60_000)

	it("H51: an array query param repeats its key", async () => {
		await rsCheck("h51_array_query")
		expect(records.map((r) => r.url)).toEqual(["/tags?ids=a&ids=b"])
	})

	it("NEW (M): a nullable query string is sent without JSON quotes", async () => {
		await rsCheck("nullable_query_unquoted")
		expect(records.map((r) => r.url)).toEqual(["/tags?maybe=foo"])
	})
})

/* ======================================================================================= */
/* Go CLI runtime                                                                          */
/* ======================================================================================= */

describe.skipIf(!hasGo)("Go CLI runtime", () => {
	let dir = ""
	let build: Run = { code: 1, err: "not built", out: "" }

	beforeAll(async () => {
		dir = mkdtempSync(join(tmpdir(), "honey-regress-cli-"))
		writeTree(dir, generateGoCLI(cliRuntimeSpec, { binaryName: "demo", modulePath: "example.com/demo" }).files)
		const tidy = await run("go", ["mod", "tidy"], dir)
		build = tidy.code === 0 ? await run("go", ["build", "-p", "4", "-o", "demo", "."], dir) : tidy
	}, 600_000)

	afterAll(() => rmSync(dir, { force: true, recursive: true }))

	async function cli(args: string[], b: Behave): Promise<Run> {
		expect(build.code, `${build.out}\n${build.err}`).toBe(0)
		reset((rec) => b(rec) ?? standard(rec))
		return run(join(dir, "demo"), [...args, "--base-url", baseA, "--api-key", "k"], dir, {}, 60_000)
	}

	it("H (cli-go/errors.go:36-39): exit codes tell a 4xx from a 5xx", async () => {
		const notFound = await cli(["items", "get", "--id", "x"], () => json({ message: "nope" }, 404))
		const broken = await cli(["items", "get", "--id", "x"], () => json({ message: "down" }, 500))
		expect(notFound.code).toBe(1)
		expect(broken.code).toBe(2)
	})

	// regression: CLI-REQUIRED-FLAG
	it("a missing required flag, an unknown flag and a stray subcommand exit 4 (usage) and send nothing", async () => {
		const missing = await cli(["items", "get"], () => undefined)
		const unknown = await cli(["items", "get", "--id", "x", "--nope"], () => undefined)
		const stray = await cli(["items", "nope"], () => undefined)
		expect(missing.code, missing.err).toBe(4)
		expect(missing.err).toMatch(/id/)
		expect(unknown.code, unknown.err).toBe(4)
		expect(stray.code, stray.err).toBe(4)
		expect(records).toEqual([])
	})

	it("M (client-go/errors.go:156-206; cli-go/output.go:53-94): hostile server bytes are not printed raw", async () => {
		const table = await cli(["items", "list", "--output", "table"], () =>
			json([{ id: 1, name: "\u001b]0;pwned\u0007" }]),
		)
		const error = await cli(["items", "get", "--id", "x"], () => json({ message: "\u001b]0;pwned\u0007 bad" }, 500))
		expect(`${table.out}${table.err}`).not.toContain("\u001b")
		expect(`${error.out}${error.err}`).not.toContain("\u001b")
	})

	it("M (cli-go/output.go:25,74,87): a large integer id is printed exactly", async () => {
		const r = await cli(["items", "list"], () => ({
			body: '{"id":1234567890123456789}',
			headers: { "content-type": "application/json" },
		}))
		expect(r.out).toContain("1234567890123456789")
	})

	it("M (codegen-go-cli.ts:918,948): the CLI sends the spec's apiKey header, not a Bearer token", async () => {
		await cli(["items", "list"], () => undefined)
		expect(records[0]?.headers["x-api-key"]).toBe("k")
		expect(records[0]?.headers.authorization).toBeUndefined()
	})
})

/* ======================================================================================= */
/* Compile findings: one minimal document each                                            */
/* ======================================================================================= */

type Lang = "go" | "rust" | "python" | "cli"
type CompileCase = {
	id: string
	lang: Lang
	spec: Record<string, unknown>
	/** Go: an extra _test.go file run with `go test`. Python: a script run after import. CLI: args whose output must match. */
	run?: string
	cliHelp?: { args: string[]; expect: RegExp }
	/** Rust: an integer test (tests/case.rs) compiled with `cargo check --tests`. */
	rustTest?: string
	/** Rust: generate in safe mode (`throwOnError: false`). */
	rustSafe?: boolean
	mypy?: boolean
}

const obj = (properties: Record<string, unknown>, required: string[] = []) => ({ properties, required, type: "object" })
const get = (operationId: string, extra: Record<string, unknown> = {}) => ({
	get: { operationId, responses: jsonOk(), ...extra },
})

const CASES: CompileCase[] = [
	{
		id: "H41 (an integer query param on an SSE operation compiles)",
		lang: "rust",
		spec: doc({
			"/chat": {
				post: {
					operationId: "chat.send",
					parameters: [queryParam("n", { type: "integer" })],
					requestBody: jsonBody(),
					responses: sseOk,
				},
			},
		}),
	},
	{
		id: "H42 (the CLI compiles a POST SSE operation with a body)",
		lang: "cli",
		spec: doc({ "/chat": { post: { operationId: "chat.send", requestBody: jsonBody(), responses: sseOk } } }),
	},
	{
		id: "H43 (JSON keys that are not identifiers)",
		lang: "python",
		spec: doc(
			{ "/x": get("x.get", { responses: jsonOk({ $ref: "#/components/schemas/Item" }) }) },
			{
				Item: obj({
					"2fa": { type: "boolean" },
					"@type": { type: "string" },
					class: { type: "string" },
					"content-type": { type: "string" },
					from: { type: "string" },
				}),
			},
		),
	},
	{
		id: "H44 (a root namespace with only streaming operations)",
		lang: "python",
		spec: doc({ "/events": { get: { operationId: "events.stream", responses: sseOk } }, "/x": get("x.get") }),
		run: "import sdk\nfrom sdk._runtime import ClientConfig\nsdk.SDK(ClientConfig(base_url='http://x'))\n",
	},
	{
		id: "H45 (query params named like the SDK's arguments)",
		lang: "python",
		spec: doc({
			"/q": get("q.list", {
				parameters: ["timeout", "headers", "cancel_token", "body", "idempotency_key"].map((n) => queryParam(n)),
			}),
		}),
	},
	{
		id: "H46 (a namespace starting with q)",
		lang: "go",
		spec: doc({ "/queue": get("queue.list", { parameters: [queryParam("state")] }) }),
	},
	{
		id: "H47 (path params named like keywords or packages)",
		lang: "go",
		spec: doc({
			"/users/{type}": get("users.get", { parameters: [pathParam("type")] }),
			"/fetch/{url}": get("fetch.get", { parameters: [pathParam("url")] }),
		}),
	},
	{
		id: "H47 (path params named like keywords)",
		lang: "rust",
		spec: doc({ "/users/{type}": get("users.get", { parameters: [pathParam("type")] }) }),
	},
	...(["go", "rust", "python"] as const).map((lang) => ({
		id: `H48 (multi-line descriptions and quotes stay comments) [${lang}]`,
		lang,
		spec: doc({
			"/d": get("docs.get", { description: 'first line\nsecond(); */ """ trailing"', summary: 'C:\\users "quoted"' }),
		}),
	})),
	...(["go", "rust"] as const).map((lang) => ({
		id: `H49 (enum values become unique identifiers) [${lang}]`,
		lang,
		spec: doc(
			{ "/e": get("e.get", { responses: jsonOk({ $ref: "#/components/schemas/Sort" }) }) },
			{ Sort: { enum: ["active", "-created_at", "created_at", "self", "1h", "text/plain", ""], type: "string" } },
		),
	})),
	{
		id: "H51 (array, nullable, bracketed and `headers` query params)",
		lang: "go",
		spec: doc({
			"/l": get("l.list", {
				parameters: [
					queryParam("ids", { items: { type: "string" }, type: "array" }),
					queryParam("maybe", { type: ["string", "null"] }),
					queryParam("page[size]", { type: "integer" }),
					queryParam("headers"),
				],
			}),
		}),
	},
	{
		id: "H51 (`timeout` and `headers` query params)",
		lang: "rust",
		spec: doc({ "/l": get("l.list", { parameters: [queryParam("timeout"), queryParam("headers")] }) }),
	},
	{
		id: "H52 (a schema named Config is the response type, not the SDK's config)",
		lang: "go",
		spec: doc(
			{ "/config": get("config.get", { responses: jsonOk({ $ref: "#/components/schemas/Config" }) }) },
			{ Config: obj({ theme: { type: "string" } }, ["theme"]) },
		),
		run: 'package sdk\n\nimport (\n\t"reflect"\n\t"testing"\n)\n\nfunc TestConfigSchemaIsTheResponse(t *testing.T) {\n\tc := NewClient(Config{BaseURL: "http://x"})\n\tout := reflect.TypeOf(c.Config.Get).Out(0).Elem()\n\tif _, ok := out.FieldByName("Theme"); !ok {\n\t\tt.Fatalf("Config.Get returns %s, which has no Theme field", out)\n\t}\n}\n',
	},
	{
		id: "H52 (schemas named Error, Option and Result)",
		lang: "rust",
		spec: doc(
			{
				"/a": get("a.get", { responses: jsonOk({ $ref: "#/components/schemas/Error" }) }),
				"/b": get("b.get", { responses: jsonOk({ $ref: "#/components/schemas/Option" }) }),
				"/c": get("c.get", { responses: jsonOk({ $ref: "#/components/schemas/Result" }) }),
			},
			{
				Error: obj({ code: { type: "string" } }),
				Option: obj({ v: { type: "string" } }),
				Result: obj({ r: { type: "string" } }),
			},
		),
	},
	{
		id: "H52 (a schema named NotFoundError does not shadow the exception)",
		lang: "python",
		spec: doc(
			{ "/a": get("a.get", { responses: jsonOk({ $ref: "#/components/schemas/NotFoundError" }) }) },
			{ NotFoundError: obj({ code: { type: "string" } }) },
		),
		run: "import sdk\nassert issubclass(sdk.NotFoundError, Exception), sdk.NotFoundError\n",
	},
	{
		id: "H53 (a namespace with only nested methods)",
		lang: "rust",
		spec: doc({ "/admin/users": get("admin.users.list") }),
	},
	{
		id: "H54 (CLI flags and variables never collide)",
		lang: "cli",
		spec: doc({
			"/items/{id}": {
				put: {
					operationId: "items.update",
					parameters: [pathParam("id")],
					requestBody: jsonBody(
						obj({
							data: { type: "string" },
							id: { type: "string" },
							user_id: { type: "string" },
							userId: { type: "string" },
						}),
					),
					responses: jsonOk(),
				},
			},
		}),
	},
	{
		id: "M (rust-type-emitter.ts:138-140): hoisted names never merge",
		lang: "rust",
		spec: doc(
			{
				"/u": get("u.get", { responses: jsonOk({ $ref: "#/components/schemas/User" }) }),
				"/p": get("p.get", { responses: jsonOk({ $ref: "#/components/schemas/UserProfile" }) }),
			},
			{
				User: obj({ profile_settings: obj({ a: { type: "string" } }) }),
				UserProfile: obj({ settings: obj({ b: { type: "number" } }) }),
			},
		),
		/* each nested type keeps its own field: one merged type would lack `a` or `b` */
		rustTest:
			"use case_sdk::types::{User, UserProfile};\n\npub fn fields(u: &User, p: &UserProfile) {\n    let _ = u.profile_settings.as_ref().map(|s| &s.a);\n    let _ = p.settings.as_ref().map(|s| &s.b);\n}\n\n#[test]\nfn compiles() {}\n",
	},
	...(["go", "rust"] as const).map((lang) => ({
		id: `M (rust-type-emitter.ts:271,403): mutual recursion compiles [${lang}]`,
		lang,
		spec: doc(
			{ "/a": get("a.get", { responses: jsonOk({ $ref: "#/components/schemas/A" }) }) },
			{
				A: obj({ b: { $ref: "#/components/schemas/B" } }, ["b"]),
				B: obj({ a: { $ref: "#/components/schemas/A" } }, ["a"]),
			},
		),
	})),
	{
		id: "M (rust-type-emitter.ts:326-368): a tagged union with inline variants compiles",
		lang: "rust",
		spec: doc(
			{ "/s": get("s.get", { responses: jsonOk({ $ref: "#/components/schemas/Shape" }) }) },
			{
				Shape: {
					discriminator: { propertyName: "kind" },
					oneOf: [
						obj({ kind: { const: "a", type: "string" }, x: { type: "string" } }, ["kind"]),
						obj({ kind: { const: "b", type: "string" }, y: { type: "number" } }, ["kind"]),
					],
				},
			},
		),
	},
	...(["go", "rust"] as const).map((lang) => ({
		id: `M (codegen-rust.ts:107; codegen-go.ts:161): an inline array response keeps its item type [${lang}]`,
		lang,
		spec: doc({
			"/list": get("list.get", { responses: jsonOk({ items: obj({ a: { type: "string" } }), type: "array" }) }),
		}),
	})),
	...(["go", "rust"] as const).map((lang) => ({
		id: `M (go-type-emitter.ts:33-35,50-52,347): field identifiers and tags are sanitized [${lang}]`,
		lang,
		spec: doc(
			{ "/f": get("f.get", { responses: jsonOk({ $ref: "#/components/schemas/F" }) }) },
			{
				F: obj({
					"2fa": { type: "boolean" },
					"@type": { type: "string" },
					'a"b': { type: "string" },
					"c`d": { type: "string" },
					user_id: { type: "string" },
					userId: { type: "string" },
				}),
			},
		),
	})),
	{
		id: "M (codegen-go-cli.ts:800,812): enum values with quotes and % stay literal",
		lang: "cli",
		spec: doc({
			"/e": get("e.list", { parameters: [queryParam("mode", { enum: ['a"b', "100%d"], type: "string" })] }),
		}),
	},
	{
		id: "M (codegen-go-cli.ts:395-400): query params named like global flags get their own flags",
		lang: "cli",
		spec: doc({ "/q": get("queue.list", { parameters: ["timeout", "output", "config"].map((n) => queryParam(n)) }) }),
		cliHelp: {
			args: ["queue", "list", "--help"],
			expect:
				/--query-timeout[\s\S]*--query-output[\s\S]*--query-config|--query-config[\s\S]*--query-output[\s\S]*--query-timeout|--query-output/,
		},
	},
	{
		id: "H (codegen-go-cli.ts:372,1170-1172): a resource named root keeps the root command",
		lang: "cli",
		spec: doc({ "/root": get("root.list"), "/pets": get("pets.list") }),
		cliHelp: { args: ["root", "list", "--help"], expect: /list/ },
	},
	{
		id: "M (codegen-rust.ts:176-197; runtime.rs:357-370): safe mode returns an API error inside SdkResult",
		lang: "rust",
		spec: doc({ "/x": get("x.get") }),
		rustSafe: true,
		/* run, not just compiled: a 404 must come back as Ok(SdkResult { error: Some(..) }) */
		rustTest: [
			"use std::io::{Read, Write};",
			"",
			"#[tokio::test]",
			"async fn safe_mode_fills_error() {",
			'    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();',
			"    let port = listener.local_addr().unwrap().port();",
			"    std::thread::spawn(move || {",
			"        for stream in listener.incoming() {",
			"            let mut s = stream.unwrap();",
			"            let mut buf = [0u8; 4096];",
			"            let _ = s.read(&mut buf);",
			'            let body = "{\\"message\\":\\"nope\\"}";',
			'            let _ = write!(s, "HTTP/1.1 404 Not Found\\r\\ncontent-type: application/json\\r\\ncontent-length: {}\\r\\nconnection: close\\r\\n\\r\\n{}", body.len(), body);',
			"        }",
			"    });",
			'    let c = case_sdk::Client::new(case_sdk::ClientConfig { base_url: format!("http://127.0.0.1:{port}"), ..Default::default() });',
			"    let r = c.x().get(&Default::default()).await;",
			'    let r = r.expect("safe mode returns Ok with the error inside");',
			"    assert!(r.error.is_some());",
			"    assert_eq!(r.status, 404);",
			"}",
			"",
		].join("\n"),
	},
	{
		id: "M (codegen-python.ts:219-227,740): nested and top-level resources with one name keep their own classes",
		lang: "python",
		spec: doc({ "/contacts": get("contacts.list"), "/sync/contacts": get("sync.contacts.list") }),
		run: [
			"import asyncio, httpx, sdk",
			"from sdk._runtime import ClientConfig",
			"seen = []",
			"def handler(req):",
			"    seen.append(req.url.path)",
			"    return httpx.Response(200, json={'ok': True})",
			"sync = sdk.SDK(ClientConfig(base_url='http://x', sync_transport=httpx.MockTransport(handler)))",
			"sync.contacts.list()",
			"sync.sync.contacts.list()",
			"async def run():",
			"    c = sdk.AsyncSDK(ClientConfig(base_url='http://x', transport=httpx.MockTransport(handler)))",
			"    await c.contacts.list()",
			"    await c.sync.contacts.list()",
			"asyncio.run(run())",
			"assert seen == ['/contacts', '/sync/contacts', '/contacts', '/sync/contacts'], seen",
			"",
		].join("\n"),
	},
	{
		id: "L (rust-type-emitter.ts:105,314): string literals use Rust escapes",
		lang: "rust",
		spec: doc(
			{ "/e": get("e.get", { responses: jsonOk({ $ref: "#/components/schemas/Esc" }) }) },
			{ Esc: { enum: ["a\bb", "c\fd", "é"], type: "string" } },
		),
	},
	{
		// regression: RUST-BARE-OBJECT
		id: "NEW (H): a bare object response compiles (HashMap in a resource file)",
		lang: "rust",
		spec: doc({ "/meta": get("meta.get", { responses: jsonOk({ type: "object" }) }) }),
	},
	{
		id: "M (codegen-python.ts:622-628): list, enum and union aliases are typed, not Any",
		lang: "python",
		spec: doc(
			{ "/t": get("t.list", { responses: jsonOk({ $ref: "#/components/schemas/Tags" }) }) },
			{ Tags: { items: { type: "string" }, type: "array" } },
		),
		mypy: true,
		run: "from sdk.types import Tags\nx: Tags = [1]\n",
	},
	{
		id: "NEW (L): return annotations are valid for type checkers",
		lang: "python",
		spec: doc({ "/x": get("x.get", { responses: jsonOk({ properties: { a: { type: "string" } }, type: "object" }) }) }),
		mypy: true,
	},
]

describe("compile findings", () => {
	const skip = (lang: Lang) => (lang === "go" || lang === "cli" ? !hasGo : lang === "rust" ? !hasCargo : !hasPython)

	for (const c of CASES) {
		it.skipIf(skip(c.lang) || (c.mypy === true && !hasMypy))(
			c.id,
			async () => {
				const dir = mkdtempSync(join(tmpdir(), `honey-regress-${c.lang}-`))
				try {
					if (c.lang === "go") {
						writeTree(dir, generateGoSDK(c.spec, { modulePath: "example.com/sdk" }).files)
						if (c.run) writeFileSync(join(dir, "zz_case_test.go"), c.run)
						const tidy = await run("go", ["mod", "tidy"], dir)
						expect(tidy.code, tidy.err).toBe(0)
						const vet = await run("go", ["vet", "-p", "4", "./..."], dir)
						expect(vet.code, `${vet.out}\n${vet.err}`).toBe(0)
						if (c.run) {
							const test = await run("go", ["test", "-p", "4", "-count=1", "."], dir)
							expect(test.code, `${test.out}\n${test.err}`).toBe(0)
						}
					} else if (c.lang === "cli") {
						writeTree(dir, generateGoCLI(c.spec, { binaryName: "demo", modulePath: "example.com/demo" }).files)
						const tidy = await run("go", ["mod", "tidy"], dir)
						expect(tidy.code, tidy.err).toBe(0)
						const build = await run("go", ["build", "-p", "4", "-o", "demo", "."], dir)
						expect(build.code, `${build.out}\n${build.err}`).toBe(0)
						const vet = await run("go", ["vet", "-p", "4", "./..."], dir)
						expect(vet.code, `${vet.out}\n${vet.err}`).toBe(0)
						if (c.cliHelp) {
							const help = await run(join(dir, "demo"), c.cliHelp.args, dir)
							expect(help.code, `${help.out}\n${help.err}`).toBe(0)
							expect(`${help.out}${help.err}`).toMatch(c.cliHelp.expect)
						}
					} else if (c.lang === "rust") {
						writeTree(dir, generateRustSDK(c.spec, { crateName: "case-sdk", throwOnError: c.rustSafe !== true }).files)
						if (c.rustTest) writeTree(dir, { "tests/case.rs": c.rustTest })
						const args = c.rustSafe
							? ["test", "-j", "4", "--quiet"]
							: c.rustTest
								? ["check", "--tests", "-j", "4", "--quiet"]
								: ["check", "-j", "4", "--quiet"]
						const check = await run("cargo", args, dir, { CARGO_TARGET_DIR })
						expect(check.code, check.err).toBe(0)
					} else {
						writeTree(join(dir, "sdk"), generatePythonSDK(c.spec).files)
						const compiled = await run(PY, ["-m", "compileall", "-q", "sdk"], dir)
						expect(compiled.code, `${compiled.out}\n${compiled.err}`).toBe(0)
						const imported = await run(PY, ["-c", "import sdk"], dir)
						expect(imported.code, imported.err).toBe(0)
						if (c.mypy) {
							/* only the generated modules: the runtime files' own typing is not what these findings are about */
							const typed = await run(
								PY,
								[
									"-m",
									"mypy",
									"--python-version",
									"3.11",
									"--no-error-summary",
									"--follow-imports=silent",
									"sdk/client.py",
									"sdk/types.py",
								],
								dir,
							)
							expect(typed.code, typed.out).toBe(0)
						}
						if (c.run && !c.mypy) {
							writeFileSync(join(dir, "case.py"), c.run)
							const r = await run(PY, ["case.py"], dir)
							expect(r.code, `${r.out}\n${r.err}`).toBe(0)
						}
						if (c.run && c.mypy) {
							/* the alias must be precise enough that a wrong element type is an error */
							writeFileSync(join(dir, "case.py"), c.run)
							const r = await run(
								PY,
								["-m", "mypy", "--python-version", "3.11", "--no-error-summary", "--follow-imports=silent", "case.py"],
								dir,
							)
							expect(r.code, r.out).not.toBe(0)
							expect(r.out).toMatch(/List item 0 has incompatible type "int"/)
						}
					}
				} finally {
					rmSync(dir, { force: true, recursive: true })
				}
			},
			600_000,
		)
	}
})
