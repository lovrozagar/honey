/**
 * Local and remote (bit 17 phase e, E1): the root help's two groups, the API's commands and the local ones; the
 * target line `→ local|remote <host>` a call writes to stderr only on a terminal and not under -q, so a pipe's stderr
 * stays one JSON line; and `config`, the run's settings with their sources (flag, env, file, default), every secret
 * redacted, and `target local|remote <host>`: loopback (localhost, 127.0.0.0/8, ::1) local, anything else remote.
 */
import { mkdtempSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { beforeAll, describe, expect, it } from "vitest"
import { goCacheDir, withGo } from "../go/__fixtures__/go-env.ts"
import { served } from "../shared/__fixtures__/recording-server.ts"
import { builtCli } from "./__fixtures__/built.ts"
import { catalog } from "./__fixtures__/catalog.ts"
import { generateGoCli } from "./module.ts"

const GO = withGo()
const SLOW = { timeout: 600_000 }

const cli = () => builtCli(generateGoCli(catalog()).files)

/** `config`'s base_url and target lines. */
const targetLines = (text: string) => text.split("\n").filter((line) => /^(base_url|target) /.test(line))
const zero = () =>
	builtCli(generateGoCli({ info: { title: "Anyrow", version: "1" }, openapi: "3.1.0", paths: {} }).files)

/** The commands a help group lists, by its title. */
const group = (help: string, title: string) => {
	const lines = help.split("\n")
	const from = lines.indexOf(title)
	if (from < 0) return []
	const end = lines.indexOf("", from)
	return lines.slice(from + 1, end).map((line) => line.trim().split(/\s+/)[0])
}

describe.skipIf(!GO)("the root help's groups (phase e)", SLOW, () => {
	beforeAll(() => void cli(), SLOW.timeout)

	it("lists the API's commands and the local ones apart, under a two-line banner naming discovery", async () => {
		const ran = await cli().cli(["--help"], {})
		expect({
			api: group(ran.stdout, "API commands:"),
			banner: ran.stdout.split("\n").slice(0, 4),
			local: group(ran.stdout, "Local commands:"),
		}).toEqual({
			api: ["deep", "hostile", "nodes", "orgs"],
			banner: [
				"Catalog",
				"",
				"Agents: `catalog commands` lists every command, one line each.",
				"`catalog schema <command>` shows one's request and answer; `catalog config` shows where calls go.",
			],
			local: ["commands", "completion", "config", "help", "schema", "skill"],
		})
	})

	it("has no API group when the API has no operation", async () => {
		const ran = await zero().cli(["--help"], {})
		expect([ran.stdout.includes("API commands:"), group(ran.stdout, "Local commands:")]).toEqual([
			false,
			["commands", "completion", "config", "help", "schema", "skill"],
		])
	})
})

describe.skipIf(!GO)("the target line on a call (phase e)", SLOW, () => {
	beforeAll(() => void cli(), SLOW.timeout)

	it("names a loopback target local on a terminal, and none under -q or on a pipe", async () => {
		const [terminal, quiet, piped] = await served(
			[0, 1, 2].map(() => ({ json: "x", status: 200 })),
			async (server) => {
				const env = { CATALOG_BASE_URL: server.url }
				return [
					await cli().cli(["orgs", "get", "a", "--json"], { env, tty: true }),
					await cli().cli(["orgs", "get", "a", "--json", "-q"], { env, tty: true }),
					await cli().cli(["orgs", "get", "a"], { env }),
				]
			},
		)
		expect([terminal?.stdout.split("\n")[0], quiet?.stdout, piped?.stdout, piped?.stderr]).toEqual([
			expect.stringMatching(/^→ local 127\.0\.0\.1:\d+$/),
			'"x"\n',
			'"x"\n',
			"",
		])
	})

	it("names a remote target by its host, and keeps a pipe's error one JSON line", async () => {
		const env = { CATALOG_BASE_URL: "http://api.example.invalid:8080" }
		const [terminal, piped] = [
			await cli().cli(["orgs", "get", "a"], { env, tty: true }),
			await cli().cli(["orgs", "get", "a"], { env }),
		]
		expect([
			terminal.stdout.split("\n")[0],
			piped.status,
			piped.stderr.split("\n").length,
			JSON.parse(piped.stderr),
		]).toEqual(["→ remote api.example.invalid:8080", 3, 2, { error: expect.objectContaining({ kind: "transport" }) }])
	})
})

describe.skipIf(!GO)("config: the resolved settings and the target (phase e)", SLOW, () => {
	beforeAll(() => void cli(), SLOW.timeout)

	it("shows each setting's source, the target flipping with the base URL from each of them", async () => {
		const file = join(mkdtempSync(join(goCacheDir("tmp"), "config-")), "config.toml")
		writeFileSync(file, 'base_url = "http://localhost:3000"\n', { mode: 0o600 })
		const runs = [
			await cli().cli(["config"], {}),
			await cli().cli(["config", "--config", file], {}),
			await cli().cli(["config", "--config", file], { env: { CATALOG_BASE_URL: "https://api.example.com/v1" } }),
			await cli().cli(["config", "--base-url", "http://[::1]:8080"], {
				env: { CATALOG_BASE_URL: "https://api.example.com" },
			}),
		]
		expect(runs.map((ran) => [ran.status, ...targetLines(ran.stdout)])).toEqual([
			[0, "base_url - (default)", "target local 127.0.0.1:1"],
			[0, "base_url http://localhost:3000 (file)", "target local localhost:3000"],
			[0, "base_url https://api.example.com/v1 (env)", "target remote api.example.com"],
			[0, "base_url http://[::1]:8080 (flag)", "target local [::1]:8080"],
		])
	})
})

describe.skipIf(!GO)("config: local and remote targets (phase e)", SLOW, () => {
	beforeAll(() => void cli(), SLOW.timeout)

	it("takes localhost, 127.0.0.0/8 and ::1 as local, and anything else as remote", async () => {
		const hosts = [
			"http://localhost",
			"http://LOCALHOST:1",
			"http://app.localhost",
			"http://127.0.0.2",
			"http://127.255.255.254:9",
			"http://[::1]",
			"http://10.0.0.1",
			"http://128.0.0.1",
			"http://[::2]",
			"http://localhost.example.com",
			"https://example.com",
		]
		const targets: string[] = []
		for (const base of hosts) {
			const ran = await cli().cli(["config", "--base-url", base], {})
			targets.push(ran.stdout.split("\n").find((line) => line.startsWith("target ")) ?? "")
		}
		expect(targets).toEqual([
			"target local localhost",
			"target local LOCALHOST:1",
			"target local app.localhost",
			"target local 127.0.0.2",
			"target local 127.255.255.254:9",
			"target local [::1]",
			"target remote 10.0.0.1",
			"target remote 128.0.0.1",
			"target remote [::2]",
			"target remote localhost.example.com",
			"target remote example.com",
		])
	})
})

describe.skipIf(!GO)("config: secrets (phase e)", SLOW, () => {
	beforeAll(() => void cli(), SLOW.timeout)

	it("never shows the API key or a credential header raw, as text or as its one JSON object", async () => {
		const env = { CATALOG_API_KEY: "sekret-key" }
		const args = ["config", "--header", "X-Api-Token: tok-123", "--header", "X-Tenant: acme"]
		const [text, json] = [await cli().cli(args, { env }), await cli().cli([...args, "--json"], { env })]
		expect({
			json: JSON.parse(json.stdout),
			leaked: [text.stdout, json.stdout].filter((out) => out.includes("sekret") || out.includes("tok-123")),
			text: text.stdout,
		}).toEqual({
			json: {
				api_key: { source: "env", value: "[redacted]" },
				base_url: { source: "default", value: "" },
				headers: { source: "flag", value: { "X-Api-Token": "[redacted]", "X-Tenant": "acme" } },
				quiet: { source: "default", value: false },
				target: { host: "127.0.0.1:1", kind: "local" },
				timeout: { source: "default", value: "30s" },
				verbose: { source: "default", value: false },
			},
			leaked: [],
			text: [
				"api_key [redacted] (env)",
				"base_url - (default)",
				"headers X-Api-Token: [redacted]; X-Tenant: acme (flag)",
				"quiet false (default)",
				"timeout 30s (default)",
				"verbose false (default)",
				"target local 127.0.0.1:1",
				"",
			].join("\n"),
		})
	})
})
