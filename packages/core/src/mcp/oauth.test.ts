import { describe, expect, it } from "vitest"
import { protectedResource } from "./oauth.ts"

const AS = { authorizationServers: ["https://auth.example"] }
const at = (url: string, headers: Record<string, string> = {}) => new Request(url, { headers })

describe("protectedResource (bit 21 f, RFC 9728)", () => {
	it("serves the endpoint's metadata at the path-inserted URI, its resource the request's origin and the path", () => {
		const resource = protectedResource({ ...AS, scopesSupported: ["a"] }, "/v1/mcp", "/mcp")
		const root = protectedResource(AS, "/", "/")
		expect([
			resource.path,
			resource.metadata("https://shop.example/.well-known/oauth-protected-resource/v1/mcp"),
			root.path,
			root.metadata("http://localhost:8080/.well-known/oauth-protected-resource").resource,
		]).toEqual([
			"/.well-known/oauth-protected-resource/v1/mcp",
			{
				authorization_servers: ["https://auth.example"],
				bearer_methods_supported: ["header"],
				resource: "https://shop.example/v1/mcp",
				scopes_supported: ["a"],
			},
			"/.well-known/oauth-protected-resource",
			"http://localhost:8080",
		])
	})

	it("escapes a quote or backslash the endpoint's path holds, inside the challenge's quoted-string", () => {
		const resource = protectedResource(AS, '/a"b\\c', "/x")
		expect(resource.challenge(at("https://shop.example/x"), 401)).toBe(
			'Bearer resource_metadata="https://shop.example/.well-known/oauth-protected-resource/a\\"b\\\\c"',
		)
	})

	it("reads the scope of a Bearer challenge alone, never a Basic one's", () => {
		const resource = protectedResource(AS, "/mcp", "/mcp")
		const url = "https://shop.example/mcp"
		expect([
			resource.challenge(at(url, { authorization: "Bearer t" }), 401, 'Basic realm="x", scope="admin"'),
			resource.challenge(at(url), 403, '  BEARER scope="a  b a"'),
		]).toEqual([
			'Bearer error="invalid_token", resource_metadata="https://shop.example/.well-known/oauth-protected-resource/mcp"',
			'Bearer error="insufficient_scope", scope="a b", resource_metadata="https://shop.example/.well-known/oauth-protected-resource/mcp"',
		])
	})
})
