/**
 * The runtime sentences a user acts on, pinned in the SDK each target emits (bit 19 k1): how an SSE stream lets its
 * connection go (item 23; Java's is java/sse.api.test.ts), that a WebSocket's dial runs no request or response hook
 * and no 401 refresh, Java's headers the JDK owns (item 21), and Rust's `default_headers` going on every hop (Q9).
 * Each sentence is read from the file it ships in, its comment markers and line breaks collapsed.
 */
import { describe, expect, it } from "vitest"
import { generateCSharpSdk } from "../csharp/sdk.ts"
import { generateGoSdk } from "../go/sdk.ts"
import { generateJavaSdk } from "../java/sdk.ts"
import { generatePythonSdk } from "../python/sdk.ts"
import { generateRustSdk } from "../rust/sdk.ts"
import { generateSdk } from "../ts/sdk.ts"
import { sse, ws } from "./__fixtures__/documents-streams.ts"

type Paths = { paths: Record<string, unknown> }
/* one document with an SSE and a WebSocket operation, so every target emits both runtimes */
const DOCUMENT = { ...sse(), paths: { ...(sse() as Paths).paths, ...(ws() as Paths).paths } }
const JAVA = "src/main/java/ai/anyrow"
const PYTHON = "src/honey_sdk/_honey"

const FILES = {
	csharp: generateCSharpSdk(DOCUMENT).files,
	go: generateGoSdk(DOCUMENT).files,
	java: generateJavaSdk(DOCUMENT).files,
	python: generatePythonSdk(DOCUMENT).files,
	rust: generateRustSdk(DOCUMENT).files,
	ts: generateSdk(DOCUMENT, { name: "TestSDK" }).files,
}

/** `source` with its comment markers and line breaks collapsed to single spaces, as a reader reads the sentence. */
const prose = (source: string) => source.replace(/[ \t]*\n[ \t]*(?:\/\/[/!]?|\*(?!\/))?[ \t]*/g, " ")

const PINS: readonly (readonly [string, keyof typeof FILES, string, string])[] = [
	[
		"release",
		"ts",
		"test-sdk.runtime.gen.ts",
		"Leaving a `for await` early (a break, return or throw) cancels the body's reader, which frees the connection.",
	],
	[
		"release",
		"go",
		"sse.go",
		"A stream method's iterator closes the response body when its range ends, a break included, so leaving the loop frees the connection.",
	],
	[
		"release",
		"rust",
		"src/events.rs",
		"the call's `cancel_on` ends it quietly, and dropping it closes the connection.",
	],
	[
		"release",
		"python",
		`${PYTHON}/events.py`,
		"Open it with ``async with`` or call ``aclose()`` to free its connection; a dropped stream frees it only when collected.",
	],
	["release", "csharp", "Runtime/Events.cs", "Each end lets the connection go: dispose it, or read it to its end."],
	[
		"ws release",
		"python",
		`${PYTHON}/ws.py`,
		"Open it with ``async with`` or call ``close()`` to free its connection; a dropped socket frees it only when collected.",
	],
	[
		"ws hook",
		"ts",
		"test-sdk.runtime.gen.ts",
		"Its dial runs no onRequest or onResponse hook, and a refused handshake's 401 is its error, with no onAuthExpired refresh.",
	],
	[
		"ws hook",
		"go",
		"ws.go",
		"Its dial runs no OnRequest or OnResponse hook, and a refused handshake's 401 is its error, with no OnAuthExpired refresh.",
	],
	[
		"ws hook",
		"rust",
		"src/ws.rs",
		"Its dial runs no `on_request` or `on_response` hook, and a refused handshake's 401 is its error, with no `on_auth_expired` refresh.",
	],
	[
		"ws hook",
		"python",
		`${PYTHON}/ws.py`,
		"Its dial runs no ``on_request`` or ``on_response`` hook, and a refused handshake's 401 is its error, with no ``on_auth_expired`` refresh.",
	],
	[
		"ws hook",
		"csharp",
		"Runtime/Ws.cs",
		"Its dial runs no OnRequest or OnResponse hook, and a refused handshake's 401 is its error, with no OnAuthExpired refresh.",
	],
	[
		"ws hook",
		"java",
		`${JAVA}/TypedWebSocket.java`,
		"Its dial runs no onRequest or onResponse hook, and a refused handshake's 401 is its error, with no onAuthExpired refresh.",
	],
	[
		"restricted headers",
		"java",
		`${JAVA}/RequestOptions.java`,
		"Connection, Content-Length, Expect, Host and Upgrade are the JDK's: naming one, here or in the client's headers, throws ConfigException rather than going unsent.",
	],
	[
		"default_headers",
		"rust",
		"src/config.rs",
		"reqwest adds a header from the builder's `default_headers` to every hop after the SDK strips, a cross-origin redirect included",
	],
]

describe("the runtime sentences a user acts on, in the SDK each target emits", () => {
	it.each(PINS)("%s (%s): %s says it", (_kind, target, path, sentence) => {
		expect(prose(FILES[target][path] ?? "")).toContain(sentence)
	})
})
