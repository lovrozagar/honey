import type { IncomingMessage } from "node:http"
import { afterEach, describe, expect, it } from "vitest"
import { httpParser, type RawRequest } from "./__fixtures__/parsed.ts"
import { nodeRequestUrl } from "./url.ts"

const parser = httpParser()
afterEach(() => parser.close())

/** The IncomingMessage for these bytes; `encrypted` marks its socket as TLS. */
async function incoming(init: RawRequest & { encrypted?: boolean } = {}): Promise<IncomingMessage> {
	const msg = await parser.parse(init)
	if (init.encrypted === true) Object.defineProperty(msg.socket, "encrypted", { value: true })
	return msg
}

const hostOf = (host: string | undefined) => (host === undefined ? [] : ([["Host", host]] as const))

describe("nodeRequestUrl: the URL is what the client sent, as Bun and Workers spell it", () => {
	// v0: 702ec7a210
	// v0: dbfcc94cd8
	// v0: 16db748496
	// v0: 0c4eaa8045
	// v0: 3c96901855
	it.each([
		["/a?b=1", "app.example", {}, "http://app.example/a?b=1"],
		["/a", "app.example:8443", { encrypted: true }, "https://app.example:8443/a"],
		["/a", "[::1]:8080", {}, "http://[::1]:8080/a"],
		["/a", "app.example.", {}, "http://app.example./a"],
		["/a/./b/../c", "h", {}, "http://h/a/c"],
		["/%2e%2e/admin", "h", {}, "http://h/admin"],
		["/.well-known/x", "h", {}, "http://h/.well-known/x"],
		["/a\\b", "h", {}, "http://h/a/b"],
		["/a<b>?q='x'", "h", {}, "http://h/a%3Cb%3E?q=%27x%27"],
		["/a#frag", "h", {}, "http://h/a"],
		["//evil.example/x", "h", {}, "http://h//evil.example/x"],
		["http://other.example/p?q", "h", {}, "http://other.example/p?q"],
		["HTTPS://Other.Example/p", "h", {}, "http://other.example/p"],
		["/a", undefined, { version: "1.0" }, "http://localhost/a"],
		["/a", "App.Example", {}, "http://app.example/a"],
		["/a", "app.example:80", {}, "http://app.example/a"],
		["/a", "app.example:443", { encrypted: true }, "https://app.example/a"],
		["/a", "app.example:443", {}, "http://app.example:443/a"],
		["/a", "127.0.0.1:3000", {}, "http://127.0.0.1:3000/a"],
		["/a", "0x7f.1", {}, "http://127.0.0.1/a"],
		["/a", "[0:0::1]:8080", {}, "http://[::1]:8080/a"],
		["/a/../b", "XN--NXASMQ6B", {}, "http://xn--nxasmq6b/b"],
	] as const)("%j with Host %j %j → %j", async (target, host, extra, expected) => {
		expect(nodeRequestUrl(await incoming({ headers: hostOf(host), target, ...extra }))).toBe(expected)
	})

	// v0: e319ee7191
	// v0: fea1319141
	// v0: 60e9d255d3
	it.each([
		["*", "h", "asterisk-form"],
		["ftp://h/x", "h", "a scheme other than http(s)"],
		["http://user:pw@h/x", "h", "userinfo in an absolute-form target"],
		["http://[::1/x", "h", "an absolute-form target that is no URL"],
		["http://exa_mple/x", "h", "an absolute-form host that is not host[:port]"],
		["/a", "", "an empty Host"],
		["/a", "h/admin?", "a Host carrying a path"],
		["/a", "a b", "a Host with a space"],
		["/a", "h:99999", "a port over 65535"],
		["/a", "-h", "a label starting with a dash"],
		["/a", "h@evil", "a Host carrying userinfo"],
		["/a", "[:::::]", "a bracketed Host that is no IPv6 address"],
		["/a", "[::1]:99999", "a bracketed Host with a port over 65535"],
		["/a", "1.2.3.256", "an IPv4 octet over 255"],
		["/a", "999999999999", "a number no IPv4 address holds"],
	])("%j with Host %j is null (%s): the request gets 400", async (target, host) => {
		expect(nodeRequestUrl(await incoming({ headers: hostOf(host), target }))).toBeNull()
	})
})

describe("nodeRequestUrl: one Host per request (RFC 9112 §3.2)", () => {
	it.each([
		["two equal Host lines", "/a", ["h", "h"]],
		["a second Host naming another authority", "/a", ["h", "evil.example"]],
		["a second Host beside an absolute-form target", "http://h/a", ["h", "evil.example"]],
		["a Host spelled in another case", "/a", ["h", "evil.example"], "HOST"],
	])("%s: null, never a pick between them", async (_case, target, hosts, second = "Host") => {
		const headers = [
			["Host", hosts[0]],
			[second, hosts[1]],
		] as [string, string][]
		expect(nodeRequestUrl(await incoming({ headers, target }))).toBeNull()
	})
})
