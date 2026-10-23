/**
 * The global flags (bit 17 phase b): each setting from its flag, else its environment variable, else the config file,
 * pinned both ways per key; the config file's lookup (--config, $<PREFIX>_CONFIG, XDG, HOME) and its refusals; the exit
 * code for each outcome a script branches on; and --verbose, which logs the call to stderr with every secret redacted,
 * the secret seeded through the flag, the environment and the config file alike.
 */
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import type { IRSchema } from "../../ir/model.ts"
import { goCacheDir, withGo } from "../go/__fixtures__/go-env.ts"
import { REFUSED_URL, type Reply, served } from "../shared/__fixtures__/recording-server.ts"
import { builtCli, type RunOptions } from "./__fixtures__/built.ts"
import { shop } from "./__fixtures__/shop.ts"
import { kebab, kindOf } from "./flags.ts"
import { generateGoCli } from "./module.ts"

const GO = withGo()

describe("a flag's kind, by its schema (phase b)", () => {
	const schemas = { Size: { enum: ["s", "m"], kind: "scalar", type: "string" } } as const
	it.each([
		["a null type", { kind: "scalar", type: "null" }, { enum: [], kind: "string", list: false }],
		[
			"a const with its type",
			{ kind: "const", type: "integer", value: 3 },
			{ enum: ["3"], kind: "integer", list: false },
		],
		["a const without one", { kind: "const", value: true }, { enum: ["true"], kind: "boolean", list: false }],
		["a ref to an enum", { kind: "ref", name: "Size" }, { enum: ["s", "m"], kind: "string", list: false }],
		[
			"a nullable ref",
			{ inner: { kind: "ref", name: "Size" }, kind: "nullable" },
			{ enum: ["s", "m"], kind: "string", list: false },
		],
		[
			"a list of a ref",
			{ items: { kind: "ref", name: "Size" }, kind: "array" },
			{ enum: ["s", "m"], kind: "string", list: true },
		],
		["a ref the document never defined", { kind: "ref", name: "Gone" }, { enum: [], kind: "json", list: false }],
		[
			"a list of objects",
			{ items: { fields: [], kind: "object" }, kind: "array" },
			{ enum: [], kind: "json", list: false },
		],
	])("reads %s", (_, schema, kind) => {
		expect(kindOf(schema as IRSchema, schemas as unknown as Record<string, IRSchema>)).toEqual(kind)
	})

	it("spells a name with no letter or digit as `value`", () => {
		expect([kebab("--"), kebab("X-Trace"), kebab("tagId")]).toEqual(["value", "x-trace", "tag-id"])
	})
})
const SLOW = { timeout: 600_000 }

const built = () => builtCli(generateGoCli(shop()).files)
const ITEM: Reply = { json: { id: "i1", name: "n" }, status: 200 }

/** A fresh directory holding `config.toml` at `under` (`shop`, `.config/shop`), its mode `mode`; the directory. */
function configDir(toml: string, under = "", mode = 0o600): string {
	const dir = mkdtempSync(join(goCacheDir("cli-config"), "dir-"))
	mkdirSync(join(dir, under), { recursive: true })
	const file = join(dir, under, "config.toml")
	writeFileSync(file, toml)
	chmodSync(file, mode)
	return dir
}

/** A config file naming `alt` as its base URL. */
const altConfig = (alt: string) => join(configDir(`base_url = "${alt}"\n`), "config.toml")

/** `items get i1` (unless `args` says otherwise) against a server answering `replies`; the run and what it sent. */
type Origins = { readonly url: string; readonly alt: string }

async function run(
	env: (server: Origins) => RunOptions["env"],
	args: string[] | ((server: Origins) => string[]) = [],
	replies = [ITEM],
) {
	const { cli } = built()
	return served(replies, async (server) => {
		const given = typeof args === "function" ? args(server) : args
		const ran = await cli(given.length > 0 ? given : ["items", "get", "i1"], { env: env(server) })
		return { ...ran, hops: server.hops }
	})
}

describe.skipIf(!GO)("the global settings: flag over environment over config file (phase b)", SLOW, () => {
	it("takes the base URL from the config file, the environment over it, the flag over both", async () => {
		const runs = [
			await run((s) => ({ SHOP_CONFIG: altConfig(s.alt) })),
			await run((s) => ({ SHOP_BASE_URL: s.url, SHOP_CONFIG: altConfig(s.alt) })),
			await run(
				(s) => ({ SHOP_BASE_URL: s.url }),
				(s) => ["items", "get", "i1", "--base-url", s.alt],
			),
		]
		expect(runs.map((ran) => [ran.status, ran.hops.map((hop) => hop.origin)])).toEqual([
			[0, ["alt"]],
			[0, ["primary"]],
			[0, ["alt"]],
		])
	})

	it("sends the API key from the config file, the environment over it, the flag over both, an empty variable unset", async () => {
		const file = join(configDir('api_key = "k-config"\n'), "config.toml")
		const keys = await Promise.all(
			[
				{ env: {}, flag: [] },
				{ env: { SHOP_API_KEY: "k-env" }, flag: [] },
				{ env: { SHOP_API_KEY: "k-env" }, flag: ["--api-key", "k-flag"] },
				{ env: { SHOP_API_KEY: "" }, flag: [] },
			].map(async ({ env, flag }) => {
				const ran = await run(
					(s) => ({ SHOP_BASE_URL: s.url, SHOP_CONFIG: file, ...env }),
					["items", "get", "i1", ...flag],
				)
				return ran.hops[0]?.headers.authorization
			}),
		)
		expect(keys).toEqual(["Bearer k-config", "Bearer k-env", "Bearer k-flag", "Bearer k-config"])
	})

	it("bounds a call by the config file's timeout, the environment over it, the flag over both", async () => {
		const file = join(configDir('timeout = "100ms"\n'), "config.toml")
		const slow: Reply[] = [{ ...ITEM, delayMs: 1500 }]
		const runs = [
			await run((s) => ({ SHOP_BASE_URL: s.url, SHOP_CONFIG: file }), [], slow),
			await run((s) => ({ SHOP_BASE_URL: s.url, SHOP_CONFIG: file, SHOP_TIMEOUT: "10s" }), [], slow),
			await run(
				(s) => ({ SHOP_BASE_URL: s.url, SHOP_TIMEOUT: "10s" }),
				["items", "get", "i1", "--timeout", "100ms"],
				slow,
			),
		]
		expect(runs.map((ran) => ran.status)).toEqual([3, 0, 3])
	})
})

describe.skipIf(!GO)("the global settings: headers and verbose (phase b)", SLOW, () => {
	it("sends the config file's headers, a --header over the one of its name", async () => {
		const file = join(configDir('[headers]\nx-a = "config"\nx-b = "config"\n'), "config.toml")
		const ran = await run(
			(s) => ({ SHOP_BASE_URL: s.url, SHOP_CONFIG: file }),
			["items", "get", "i1", "--header", "x-a: flag"],
		)
		expect([ran.hops[0]?.headers["x-a"], ran.hops[0]?.headers["x-b"]]).toEqual(["flag", "config"])
	})

	it("logs under the config file's verbose, the environment over it, the flag over both", async () => {
		const file = join(configDir("verbose = true\n"), "config.toml")
		const runs = [
			await run((s) => ({ SHOP_BASE_URL: s.url, SHOP_CONFIG: file })),
			await run((s) => ({ SHOP_BASE_URL: s.url, SHOP_CONFIG: file, SHOP_VERBOSE: "false" })),
			await run((s) => ({ SHOP_BASE_URL: s.url, SHOP_VERBOSE: "false" }), ["items", "get", "i1", "--verbose"]),
		]
		expect(runs.map((ran) => ran.stderr.startsWith("> GET "))).toEqual([true, false, true])
	})
})

describe.skipIf(!GO)("the config file: where it is found, and what it refuses (phase b)", SLOW, () => {
	it("reads $XDG_CONFIG_HOME/<name>/config.toml, else ~/.config/<name>/config.toml", async () => {
		const [xdg, home] = [
			await run((s) => ({ XDG_CONFIG_HOME: configDir(`base_url = "${s.url}"\n`, "shop") })),
			await run((s) => ({ HOME: configDir(`base_url = "${s.url}"\n`, ".config/shop") })),
		]
		expect([xdg.status, home.status, xdg.hops.length, home.hops.length]).toEqual([0, 0, 1, 1])
	})

	it.each([
		[
			"--config naming no file",
			{ args: ["--config", "/nonexistent/c.toml"], env: {} },
			"config file /nonexistent/c.toml",
		],
		[
			"$SHOP_CONFIG naming no file",
			{ args: [], env: { SHOP_CONFIG: "/nonexistent/c.toml" } },
			"config file /nonexistent/c.toml",
		],
		[
			"an unknown key",
			{ args: [], toml: 'base_ur1 = "x"\n' },
			"strict mode: fields in the document are missing in the target struct",
		],
		[
			"a timeout that is no duration",
			{ args: [], toml: 'timeout = "soon"\n' },
			`the config file's timeout: "soon" is not a duration`,
		],
		["a header with no name", { args: ["--header", "novalue"], env: {} }, `--header "novalue": want "Name: value"`],
		[
			"$SHOP_VERBOSE no boolean",
			{ args: [], env: { SHOP_VERBOSE: "loud" } },
			`$SHOP_VERBOSE: "loud" is not true or false`,
		],
	])("refuses %s with exit 4 before anything is sent", async (_, given, message) => {
		const config = "toml" in given ? { SHOP_CONFIG: join(configDir(given.toml as string), "config.toml") } : {}
		const ran = await run(
			(s) => ({ SHOP_BASE_URL: s.url, ...config, ...("env" in given ? given.env : {}) }),
			["items", "get", "i1", ...given.args],
		)
		expect([ran.status, ran.stderr.includes(message), ran.hops.length]).toEqual([4, true, 0])
	})
})

describe.skipIf(!GO)("the config file's key warning, and the API with no server (phase b)", SLOW, () => {
	it("warns when a config file holding an API key is readable by others, and not when it is not", async () => {
		const [open, closed] = [0o644, 0o600].map((mode) => join(configDir('api_key = "k"\n', "", mode), "config.toml"))
		const runs = [
			await run((s) => ({ SHOP_BASE_URL: s.url, SHOP_CONFIG: open as string })),
			await run((s) => ({ SHOP_BASE_URL: s.url, SHOP_CONFIG: closed as string })),
		]
		expect(runs.map((ran) => [ran.status, ran.stderr])).toEqual([
			[0, `shop: warning: ${open} holds an API key and others can read it; chmod 600 it\n`],
			[0, ""],
		])
	})

	it("calls the API's first server when no base URL is set", async () => {
		const withServer = { ...shop(), servers: [{ url: REFUSED_URL }] }
		const ran = await builtCli(generateGoCli(withServer).files).cli(["health"])
		expect([ran.status, ran.stderr.includes("127.0.0.1:1")]).toEqual([3, true])
	})

	it("refuses a call with no base URL when the API declares no server", async () => {
		const ran = await run(() => ({}))
		expect([ran.status, ran.stderr]).toEqual([
			4,
			"shop: no base URL: set --base-url, $SHOP_BASE_URL or base_url in the config file\n",
		])
	})
})

describe.skipIf(!GO)("the exit codes a script branches on (phase b)", SLOW, () => {
	it("exits 0 on 2xx, 1 on 4xx, 2 on 5xx, 5 on a redirect it does not follow, 3 with no answer", async () => {
		const runs = await Promise.all(
			[
				[ITEM],
				[{ json: { error_key: "item_not_found", message: "no such item" }, status: 404 }],
				[{ json: { message: "down" }, status: 503 }],
				[{ redirect: { origin: "alt", path: "/elsewhere" }, status: 302 }],
			].map((replies) => run((s) => ({ SHOP_BASE_URL: s.url }), [], replies as Reply[])),
		)
		const refused = await run(() => ({ SHOP_BASE_URL: REFUSED_URL }))
		expect([...runs, refused].map((ran) => ran.status)).toEqual([0, 1, 2, 5, 3])
	})

	it("exits 130 when interrupted mid-call", async () => {
		const { cli } = built()
		const ran = await served([{ ...ITEM, delayMs: 10_000 }], (server) => {
			const arrived = new Promise<void>((resolve) => {
				const poll = setInterval(() => server.hops.length > 0 && (clearInterval(poll), resolve()), 5)
			})
			return cli(["items", "get", "i1"], { env: { SHOP_BASE_URL: server.url }, interrupt: arrived })
		})
		expect(ran.status).toBe(130)
	})
})

describe.skipIf(!GO)("--verbose: the call on stderr, every secret redacted (phase b)", SLOW, () => {
	const SECRET = "s3cr3t-Z9"
	it.each([
		["the flag", (): { args: string[]; env: Record<string, string> } => ({ args: ["--api-key", SECRET], env: {} })],
		["the environment", () => ({ args: [], env: { SHOP_API_KEY: SECRET } })],
		[
			"the config file",
			() => ({ args: [], env: { SHOP_CONFIG: join(configDir(`api_key = "${SECRET}"\n`), "config.toml") } }),
		],
		["a --header", () => ({ args: ["--header", `x-api-key: ${SECRET}`], env: {} })],
	])("logs the request and the response with the API key from %s redacted everywhere", async (_, seed) => {
		const { args, env } = seed()
		/* the answer echoes the secret under a header no credential name marks: only the value's own redaction hides it */
		const echoed: Reply[] = [{ ...ITEM, headers: { "x-echo": `seen ${SECRET}` } }]
		const ran = await run(
			(s) => ({ SHOP_BASE_URL: s.url, ...env }),
			["items", "get", "i1", "--verbose", ...args],
			echoed,
		)
		const sent = Object.entries(ran.hops[0]?.headers ?? {}).find(([, value]) => value.includes(SECRET))?.[0]
		const lines = ran.stderr.split("\n")
		expect({
			echo: lines.includes("< x-echo: seen [redacted]"),
			logged: lines.includes(`> ${sent}: [redacted]`),
			request: /^> GET http:\/\/127\.0\.0\.1:\d+\/items\/i1$/.test(lines[0] ?? ""),
			response: lines.includes("< 200"),
			secret: ran.stderr.includes(SECRET) || ran.stdout.includes(SECRET),
			sent: sent !== undefined,
		}).toEqual({ echo: true, logged: true, request: true, response: true, secret: false, sent: true })
	})
})
