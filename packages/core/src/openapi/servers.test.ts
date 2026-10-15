import { describe, expect, it } from "vitest"
import { honey } from "../routing/app.ts"
import { generateOpenApi } from "./generate.ts"
import { serversOf } from "./servers.ts"

const INFO = { title: "T", version: "1" }

/** The errors `serversOf` reports for `servers`. */
function errorsOf(servers: Parameters<typeof serversOf>[0], stripPrefix: string | null = null): string[] {
	const errors: string[] = []
	serversOf(servers, stripPrefix, (message) => void errors.push(message))
	return errors
}

describe("servers: the default, and the list a caller gives", () => {
	// v0: 3901a90210
	it("names the stripped prefix as the one server, and keeps the slash trailingSlash enforce makes clients send", () => {
		const app = honey<{}>().stripPrefix("/api").trailingSlash("enforce")
		app.get("/users/:id").handler((c) => c.res.text("ok", "ok"))
		app.get("/").handler((c) => c.res.text("ok", "ok"))
		const doc = generateOpenApi(app, { info: INFO })
		expect([doc.servers, Object.keys(doc.paths).sort()]).toEqual([[{ url: "/api" }], ["/", "/users/{id}/"]])
	})

	it("has no servers without a prefix or a list", () => {
		const app = honey<{}>()
		app.get("/a").handler((c) => c.res.text("ok", "ok"))
		expect(generateOpenApi(app, { info: INFO }).servers).toBeUndefined()
	})

	it("replaces the default with the list given, the stripped prefix appended to each URL and basePath left in the paths", () => {
		const app = honey<{}>().stripPrefix("/api")
		app
			.basePath("/v1")
			.get("/users")
			.handler((c) => c.res.text("ok", "ok"))
		const doc = generateOpenApi(app, {
			info: INFO,
			servers: [
				{ description: "Production", url: "https://api.example.com/" },
				{
					url: "https://{region}.example.com:{port}",
					variables: {
						port: { default: "443" },
						region: { default: "eu", description: "Data region", enum: ["eu", "us"] },
					},
				},
				{ url: "http://localhost:3000" },
			],
		})
		expect([doc.servers, Object.keys(doc.paths)]).toEqual([
			[
				{ description: "Production", url: "https://api.example.com/api" },
				{
					url: "https://{region}.example.com:{port}/api",
					variables: {
						port: { default: "443" },
						region: { default: "eu", description: "Data region", enum: ["eu", "us"] },
					},
				},
				{ url: "http://localhost:3000/api" },
			],
			["/v1/users"],
		])
	})

	it("writes each server as given without a prefix, and an empty list as no servers", () => {
		expect([serversOf([{ url: "https://a.example.com/" }], null, () => {}), serversOf([], "/api", () => {})]).toEqual([
			[{ url: "https://a.example.com/" }],
			[],
		])
	})
})

describe("servers: a list that cannot be served is refused", () => {
	it("refuses an undeclared variable, an unused one, a default outside its enum, an empty enum and a bad name", () => {
		expect([
			errorsOf([{ url: "https://{env}.example.com" }]),
			errorsOf([{ url: "https://example.com", variables: { env: { default: "prod" } } }]),
			errorsOf([{ url: "https://{env}.example.com", variables: { env: { default: "dev", enum: ["prod"] } } }]),
			errorsOf([{ url: "https://{env}.example.com", variables: { env: { default: "dev", enum: [] } } }]),
			errorsOf([{ url: "https://{bad-name}.example.com", variables: { "bad-name": { default: "x" } } }]),
		]).toEqual([
			[expect.stringMatching(/server 1 \("https:\/\/\{env\}\.example\.com"\): \{env\} is not declared/)],
			[expect.stringMatching(/variable "env" is declared but not used/)],
			[expect.stringMatching(/variable "env": default "dev" is not in its enum/)],
			[expect.stringMatching(/variable "env": an enum must list at least one value/)],
			[expect.stringMatching(/variable "bad-name": a name is letters, digits and _ only/)],
		])
	})

	it("refuses a control character anywhere a server writes text, and an unmatched brace", () => {
		expect([
			errorsOf([{ url: "https://example.com/\n<script>" }]),
			errorsOf([{ url: "https://{env}.example.com", variables: { env: { default: "a\u0000b" } } }]),
			errorsOf([{ url: "https://{env}.example.com", variables: { env: { default: "a", enum: ["a", "b\r"] } } }]),
			errorsOf([{ url: "https://{env}.example.com", variables: { env: { default: "a", description: "x\u0007" } } }]),
			errorsOf([{ description: "Prod\u001b[31m", url: "https://example.com" }]),
			errorsOf([{ url: "https://{env.example.com" }]),
		]).toEqual([
			[expect.stringMatching(/server 1 \(.*\): the URL holds a control character/)],
			[expect.stringMatching(/variable "env": its default holds a control character/)],
			[expect.stringMatching(/variable "env": its enum holds a control character/)],
			[expect.stringMatching(/variable "env": its description holds a control character/)],
			[expect.stringMatching(/server 1 \(.*\): the description holds a control character/)],
			[expect.stringMatching(/server 1 \(.*\): the URL has an unmatched brace/)],
		])
	})

	it("fails the document on any of them, as INVALID_SERVER, all at once", () => {
		const app = honey<{}>()
		app.get("/a").handler((c) => c.res.text("ok", "ok"))
		expect(() =>
			generateOpenApi(app, {
				info: INFO,
				servers: [{ url: "https://{a}.example.com" }, { url: "https://{b}.example.com" }],
			}),
		).toThrow(/INVALID_SERVER.*server 1.*\{a\}.*INVALID_SERVER.*server 2.*\{b\}/s)
	})
})
