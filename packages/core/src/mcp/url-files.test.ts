import { describe, expect, it } from "vitest"
import { urlFiles } from "./url-files.ts"

/** A fetch that is never reached: any call is a leg's failure. */
const unreachable = async (request: Request): Promise<Response> => {
	throw new Error(`fetched ${request.url}`)
}

/** The refusal `urlFiles(options)` throws, or "made" when it makes the fetch. */
function made(options: Parameters<typeof urlFiles>[0]): string {
	try {
		urlFiles({ fetch: unreachable, ...options })
		return "made"
		/* the refusal's message is the leg's value */
	} catch (error) {
		return (error as Error).message
	}
}

describe("urlFiles(options) refuses options that cannot work (bit 21 g, R6)", () => {
	it("refuses an empty list, and entries that are no bare host", () => {
		expect(
			[[], ["files.example.com/path"], ["user@files.example.com"], ["files.example.com?q=1"], ["a b"], [""]].map(
				(hosts) => made({ hosts }),
			),
		).toEqual([
			"urlFiles(): hosts lists no host",
			"urlFiles(): hosts names files.example.com/path, which is no host",
			"urlFiles(): hosts names user@files.example.com, which is no host",
			"urlFiles(): hosts names files.example.com?q=1, which is no host",
			"urlFiles(): hosts names a b, which is no host",
			"urlFiles(): hosts names , which is no host",
		])
	})
})

describe("urlFiles(options) lists hosts by name alone (bit 21 g, R6)", () => {
	it.each([
		"127.0.0.1",
		"2130706433",
		"0x7f.0.0.1",
		"0177.0.0.1",
		"10.0.0.1",
		"169.254.169.254",
		"0.0.0.0",
		"[::1]",
		"[::ffff:127.0.0.1]",
		"[fe80::1]",
		"*.127.0.0.1",
		"*.[::1]",
	])("refuses the IP literal %s in any form the URL parser reads as one", (entry) => {
		expect(made({ hosts: [entry] })).toBe(
			`urlFiles(): hosts names ${entry.replace(/^\*\./, "")}, an IP address; list hosts by name`,
		)
	})

	it("refuses a maxBytes or timeoutMs that is no whole number, and takes names, ports and wildcards", () => {
		const hosts = ["files.example.com"]
		expect([
			made({ hosts, maxBytes: -1 }),
			made({ hosts, maxBytes: 1.5 }),
			made({ hosts, timeoutMs: 0 }),
			made({ hosts, timeoutMs: Number.NaN }),
			made({ hosts: ["Files.Example.com", "files.example.com:8443", "*.cdn.example.com"], maxBytes: 0, timeoutMs: 1 }),
		]).toEqual([
			"urlFiles(): maxBytes is no whole number of bytes",
			"urlFiles(): maxBytes is no whole number of bytes",
			"urlFiles(): timeoutMs is no whole number of milliseconds",
			"urlFiles(): timeoutMs is no whole number of milliseconds",
			"made",
		])
	})

	it("fetches through the platform's fetch when none is given, never for a host off the list", async () => {
		const fetchFile = urlFiles({ hosts: ["files.example.com"] })
		await expect(fetchFile("https://elsewhere.example/a", new AbortController().signal)).rejects.toThrow(
			"is on elsewhere.example, a host this server fetches no file from",
		)
		/* an aborted call: the platform's fetch rejects before any connection, so no network is touched */
		await expect(fetchFile("https://files.example.com/a", AbortSignal.abort())).rejects.toMatchObject({
			name: "AbortError",
		})
	})
})
