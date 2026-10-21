/**
 * A refused-connection leg aims at `REFUSED_URL`, a port nothing can ever bind, never at a server it just closed: the
 * kernel hands a freed ephemeral port to the next listener, so a concurrent test's server could take it before the
 * driver connects, and the call would reach that server and answer instead of being refused (CI run 39683781578:
 * python's refused leg got a 200 from the empty-map leg's server, which then saw a hop it never made).
 */
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, resolve } from "node:path"
import { describe, expect, it } from "vitest"
import { REFUSED_URL } from "../../src/emit/shared/__fixtures__/recording-server.ts"

const GEN = resolve(import.meta.dirname, "../..")
/* this file names the idiom in its own legs */
const SELF = "tests/structure/refused-url.test.ts"

/** Every TS file under `dir`, recursively, gen-relative. */
function tsFiles(dir: string): string[] {
	return readdirSync(join(GEN, dir)).flatMap((name) => {
		const path = join(dir, name)
		if (statSync(join(GEN, path)).isDirectory()) return name === "_tokenizer" ? [] : tsFiles(path)
		return name.endsWith(".ts") ? [path] : []
	})
}

/* a server's URL taken only to be used after the server closes: `served([], … => server.url)` */
const CLOSED_URL = /served\(\s*\[\]\s*,\s*(?:async\s*)?\(?\s*\w+\s*\)?\s*=>\s*\w+\.url\s*\)/

describe("refused-connection legs", () => {
	it("never take a closed server's URL, which a concurrent server may already hold", () => {
		const found = ["src", "tests"]
			.flatMap(tsFiles)
			.filter((path) => path !== SELF && CLOSED_URL.test(readFileSync(join(GEN, path), "utf8")))
		expect(found).toEqual([])
	})

	it("recognizes the closed-server idiom, sync or async, and not a live use of a server's URL", () => {
		expect(
			[
				"served([], async (server) => server.url)",
				"served([], (s) => s.url)",
				"served([reply], async (server) => run(server.url))",
			].map((text) => CLOSED_URL.test(text)),
		).toEqual([true, true, false])
	})

	it("aims at a privileged port on the loopback, which no unprivileged process can bind and nothing serves", () => {
		expect(REFUSED_URL).toBe("http://127.0.0.1:1")
	})
})
