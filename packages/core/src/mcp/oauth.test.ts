import { describe, expect, it } from "vitest"
import { honey } from "../routing/app.ts"
import { oauth } from "./oauth.ts"

const AS = { authorizationServers: ["https://auth.example"] }
const at = (url: string, headers: Record<string, string> = {}) => new Request(url, { headers })

describe("oauth(options) (bit 21 f, RFC 9728)", () => {
	it("refuses options the spec forbids when called, before any mount", () => {
		expect(() => oauth({ authorizationServers: [] })).toThrow("oauth(): authorizationServers lists no")
	})

	it("serves the endpoint's metadata at the path-inserted URI once registered, beside the origin", async () => {
		const app = honey()
		const hook = oauth({ ...AS, scopesSupported: ["a"] })(app.basePath("/v1"), "/mcp")
		const root = honey()
		oauth(AS)(root, "/").register()
		hook.register()
		const served = await app.fetch(at("https://shop.example/.well-known/oauth-protected-resource/v1/mcp"), {})
		const atRoot = await root.fetch(at("http://localhost:8080/.well-known/oauth-protected-resource"), {})
		expect([await served.json(), ((await atRoot.json()) as { resource: string }).resource]).toEqual([
			{
				authorization_servers: ["https://auth.example"],
				bearer_methods_supported: ["header"],
				resource: "https://shop.example/v1/mcp",
				scopes_supported: ["a"],
			},
			"http://localhost:8080",
		])
	})

	it("escapes a backslash the endpoint's path holds inside the challenge's quoted-string (a quote arrives encoded)", () => {
		const hook = oauth(AS)(honey(), '/a"b\\c')
		expect(hook.challenge(at("https://shop.example/x"), 401)).toBe(
			'Bearer resource_metadata="https://shop.example/.well-known/oauth-protected-resource/a%22b\\\\c"',
		)
	})

	it("reads the scope of a Bearer challenge alone, never a Basic one's", () => {
		const hook = oauth(AS)(honey(), "/mcp")
		const url = "https://shop.example/mcp"
		expect([
			hook.challenge(at(url, { authorization: "Bearer t" }), 401, 'Basic realm="x", scope="admin"'),
			hook.challenge(at(url), 403, '  BEARER scope="a  b a"'),
		]).toEqual([
			'Bearer error="invalid_token", resource_metadata="https://shop.example/.well-known/oauth-protected-resource/mcp"',
			'Bearer error="insufficient_scope", scope="a b", resource_metadata="https://shop.example/.well-known/oauth-protected-resource/mcp"',
		])
	})
})
