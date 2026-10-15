import { describe, expect, it } from "vitest"
import { honey } from "../routing/app.ts"
import { SILENT, type Logger } from "../telemetry/logger.ts"
import { generateOpenApi } from "./generate.ts"

const INFO = { title: "T", version: "1" }
const BEARER = { bearerFormat: "JWT", scheme: "bearer", type: "http" }

/** A logger that keeps each warning's message. */
function recording(): { logger: Logger; warnings: string[] } {
	const warnings: string[] = []
	const warn = (first: unknown, second?: unknown) =>
		void warnings.push(String(typeof first === "string" ? first : second))
	return { logger: { ...SILENT, warn }, warnings }
}

describe("security: schemes and the requirements that name them", () => {
	// v0: f0e6dfd0bb
	it("emits the securitySchemes option under components", () => {
		const app = honey<{}>()
		app.get("/health").handler((c) => c.res.text("ok", "ok"))
		expect(generateOpenApi(app, { info: INFO, securitySchemes: { bearerAuth: BEARER } }).components).toEqual({
			securitySchemes: { bearerAuth: BEARER },
		})
	})

	// v0: 518ac0bd29
	it("fails generation on a requirement naming a scheme the document does not declare, and passes once it does", () => {
		const app = honey<{}>()
		app
			.get("/me")
			.meta({ security: "jwt" })
			.handler((c) => c.res.text("ok", "ok"))
		const apiKey = { in: "header", name: "k", type: "apiKey" }
		expect(() => generateOpenApi(app, { info: INFO, securitySchemes: { apiKey } })).toThrow(
			/UNKNOWN_SECURITY_SCHEME.*GET \/me: security names "jwt"/s,
		)
		expect(generateOpenApi(app, { info: INFO, securitySchemes: { jwt: BEARER } }).paths["/me"]?.get?.security).toEqual([
			{ jwt: [] },
		])
	})

	it("only warns, through the logger, when no securitySchemes are passed at all", () => {
		const app = honey<{}>()
		app
			.get("/me")
			.meta({ security: ["jwt", "key"] })
			.handler((c) => c.res.text("ok", "ok"))
		const { logger, warnings } = recording()
		generateOpenApi(app, { info: INFO, logger })
		expect(warnings).toEqual([
			expect.stringMatching(
				/UNKNOWN_SECURITY_SCHEME.*security scheme "jwt" \(first used by GET \/me\) is not declared/s,
			),
			expect.stringMatching(/UNKNOWN_SECURITY_SCHEME.*security scheme "key"/s),
		])
	})
})

describe("security: an undeclared scheme, said once", () => {
	it("warns once per scheme however many operations name it", () => {
		const app = honey<{}>()
		for (const path of ["/a", "/b"])
			app
				.get(path)
				.meta({ security: "jwt" })
				.handler((c) => c.res.text("ok", "ok"))
		const { logger, warnings } = recording()
		generateOpenApi(app, { info: INFO, logger })
		expect(warnings).toEqual([expect.stringMatching(/security scheme "jwt" \(first used by GET \/a\)/s)])
	})
})
