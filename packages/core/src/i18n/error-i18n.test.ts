import { describe, expect, it, vi } from "vitest"
import { HoneyError } from "../errors/error.ts"
import { DIGEST } from "../errors/projector.ts"
import { honey } from "../routing/app.ts"
import { createLogger } from "../telemetry/logger.ts"
import { errorI18n, type ErrorTranslations, translateError } from "./error-i18n.ts"

const fieldError = (path: string) => ({ error_key: "invalid", message: "invalid", path })

/** The HoneyError input validation answers with (bit 08 builds it from a schema; here it is thrown as is). */
function invalidInput(paths: Record<string, string[]>): HoneyError {
	return new HoneyError({
		errorKey: "validation_failed",
		fields: Object.fromEntries(Object.entries(paths).map(([source, list]) => [source, list.map(fieldError)])),
		status: "bad_request",
	})
}

/** Templates in English and German, and English field names. */
const translations: ErrorTranslations = {
	errors: {
		de: { item_gone: "{name} ist weg" },
		en: { item_gone: "{name} is gone", quota: "{n, plural, one {# slot} other {# slots}} left" },
	},
	fieldNames: { en: { "json.email": "Email Address", name: "Full Name" } },
}

describe("translateError(): a translated copy", () => {
	it("the message from the locale's template, its vars filled; key, status, data, headers and cause kept", () => {
		const cause = new Error("db")
		const error = new HoneyError({
			cause,
			data: { id: 7 },
			errorKey: "item_gone",
			headers: { "x-a": "1" },
			status: "gone",
			vars: { name: "Order 7" },
		})
		const translated = translateError(error, translations, "de")
		expect([
			translated.message,
			translated.errorKey,
			translated.status,
			translated.data,
			translated.headers,
			translated.cause,
		]).toEqual(["Order 7 ist weg", "item_gone", 410, { id: 7 }, { "x-a": "1" }, cause])
	})

	it("plural vars are formatted for the locale", () => {
		const error = new HoneyError({ errorKey: "quota", status: "too_many_requests", vars: { n: 1 } })
		expect(translateError(error, translations, "en").message).toBe("1 slot left")
	})

	it("field paths take their display names: exact first, then without leading segments", () => {
		const error = invalidInput({ json: ["json.email", "json.name", "json.age"] })
		const paths = translateError(error, translations, "en").fields.json?.map((field) => field.path)
		expect(paths).toEqual(["Email Address", "Full Name", "json.age"])
	})
})

describe("translateError(): what stays as it was", () => {
	it("nothing to translate (an unknown locale, an unknown key, no fields): the same error, untouched", () => {
		const error = new HoneyError({ errorKey: "item_gone", status: "gone", vars: { name: "x" } })
		const other = new HoneyError({ errorKey: "unlisted", status: "gone" })
		expect([
			translateError(error, translations, "fr") === error,
			translateError(other, translations, "en") === other,
		]).toEqual([true, true])
	})

	it("the thrown error is never changed: one instance, translated per locale", () => {
		const error = new HoneyError({
			errorKey: "item_gone",
			fields: { json: [fieldError("json.email")] },
			status: "gone",
			vars: { name: "A" },
		})
		const [en, de] = [translateError(error, translations, "en"), translateError(error, translations, "de")]
		expect([en.message, de.message, error.message, error.fields.json?.[0]?.path]).toEqual([
			"A is gone",
			"A ist weg",
			"item_gone",
			"json.email",
		])
	})

	it("an error whose stack was removed still translates, keeping the copy's own", () => {
		const error = new HoneyError({ errorKey: "item_gone", status: "gone", vars: { name: "A" } })
		Reflect.deleteProperty(error, "stack")
		const translated = translateError(error, translations, "en")
		expect([translated.message, typeof translated.stack]).toEqual(["A is gone", "string"])
	})

	it("a 5xx's digest travels with the copy, so the client still gets it", () => {
		const error = new HoneyError({ errorKey: "item_gone", status: "internal_server_error", vars: { name: "x" } })
		Object.defineProperty(error, DIGEST, { value: "0123456789abcdef" })
		expect((translateError(error, translations, "en") as unknown as Record<symbol, unknown>)[DIGEST]).toBe(
			"0123456789abcdef",
		)
	})

	it("a locale, key or field named like a prototype member misses", () => {
		const error = new HoneyError({
			errorKey: "constructor",
			fields: { json: [fieldError("toString")] },
			status: "gone",
		})
		const inEnglish = translateError(error, translations, "en")
		expect([
			translateError(error, translations, "__proto__") === error,
			inEnglish.message,
			inEnglish.fields.json?.[0]?.path,
		]).toEqual([true, "constructor", "toString"])
	})
})

describe("errorI18n(): the value app.errorI18n carries", () => {
	it("is frozen, and translates through its own formatter", () => {
		const value = errorI18n({ errors: { en: { item_gone: "{name} is gone" } }, resolveLocale: () => "en" })
		const error = new HoneyError({ errorKey: "item_gone", status: "gone", vars: { name: "A" } })
		expect([
			Object.isFrozen(value),
			value.translate(error, "en").message,
			value.resolveLocale === value.resolveLocale,
		]).toEqual([true, "A is gone", true])
	})

	it("a raw config handed to app.errorI18n is refused at startup, pointing at errorI18n()", () => {
		const raw = { errors: {}, resolveLocale: () => "en" } as never
		expect(() => honey<{}>().errorI18n(raw)).toThrow(
			"app.errorI18n(): pass errorI18n({ ... }) from @lovrozagar/honey/i18n",
		)
	})
})

/** An app that throws `error` from GET /x and /x/:id, with errorI18n set when `locale` resolves one. */
function app(error: () => HoneyError, resolveLocale?: Parameters<typeof errorI18n>[0]["resolveLocale"]) {
	const lines: Record<string, unknown>[] = []
	const a = honey<{ TENANT: string }>()
	a.logger(
		createLogger({
			format: "json",
			level: "info",
			write: (line) => lines.push(JSON.parse(line) as Record<string, unknown>),
		}),
	)
	if (resolveLocale) {
		a.errorI18n(
			errorI18n({
				errors: {
					de: { item_gone: "{name} ist weg", validation_failed: "Ungültige Eingabe" },
					en: { item_gone: "{name} is gone" },
				},
				fieldNames: { de: { email: "E-Mail" } },
				resolveLocale,
			}),
		)
	}
	a.get("/x").handler(() => {
		throw error()
	})
	a.get("/x/:id").handler(() => {
		throw error()
	})
	return Object.assign(a, { lines })
}

const gone = () => new HoneyError({ errorKey: "item_gone", status: "gone", vars: { name: "Order 7" } })

async function body(res: Response) {
	return (await res.json()) as {
		error_key: string
		fields: Record<string, { error_key: string; path: string }[]>
		message: string
	}
}

describe("app.errorI18n: the answer to a thrown error is translated", () => {
	it("each request in its own locale; one shared error instance, never changed", async () => {
		const shared = gone()
		const a = app(
			() => shared,
			({ headers }) => (headers["accept-language"]?.startsWith("de") ? "de" : "en"),
		)
		const [de, en] = [
			await body(
				await a.fetch(new Request("http://app.test/x", { headers: { "accept-language": "de-DE" } }), { TENANT: "t" }),
			),
			await body(await a.fetch(new Request("http://app.test/x"), { TENANT: "t" })),
		]
		expect([de.message, en.message, shared.message]).toEqual(["Order 7 ist weg", "Order 7 is gone", "item_gone"])
	})

	it("field paths and the message together, error_key kept per field", async () => {
		const a = app(
			() => invalidInput({ json: ["json.email"] }),
			() => "de",
		)
		const answer = await body(await a.fetch(new Request("http://app.test/x"), { TENANT: "t" }))
		expect([answer.message, answer.fields.json]).toEqual([
			"Ungültige Eingabe",
			[{ error_key: "invalid", message: "invalid", path: "E-Mail" }],
		])
	})

	it("resolveLocale gets the request: cookies, env, headers, params, req and search", async () => {
		const seen = vi.fn((_ctx: unknown) => "en")
		await app(gone, seen).fetch(
			new Request("http://app.test/x/42?lang=de", { headers: { cookie: "lang=fr", "x-locale": "it" } }),
			{ TENANT: "acme" },
		)
		const ctx = seen.mock.calls[0]?.[0] as {
			cookies: Record<string, string>
			env: { TENANT: string }
			headers: Record<string, string>
			params: Record<string, string>
			req: Request
			search: Record<string, string>
		}
		expect([
			ctx.cookies.lang,
			ctx.env.TENANT,
			ctx.headers["x-locale"],
			ctx.params.id,
			ctx.req.url,
			ctx.search.lang,
		]).toEqual(["fr", "acme", "it", "42", "http://app.test/x/42?lang=de", "de"])
	})
})

describe("app.errorI18n: resolveLocale and the operator's line", () => {
	it("resolveLocale may answer later", async () => {
		const answer = await body(
			await app(gone, async () => "de").fetch(new Request("http://app.test/x"), { TENANT: "t" }),
		)
		expect(answer.message).toBe("Order 7 ist weg")
	})

	it("the operator's line keeps the raw error; only the client's answer is translated", async () => {
		const a = app(
			() => {
				throw new Error("db down")
			},
			() => "de",
		)
		await a.fetch(new Request("http://app.test/x"), { TENANT: "t" })
		expect(a.lines.map((line) => [line.msg, (line.err as { message: string }).message])).toEqual([
			["unhandled error", "db down"],
		])
	})
})

describe("app.errorI18n: when it cannot translate", () => {
	it.each([
		[
			"throws",
			() => {
				throw new Error("no locale")
			},
		],
		[
			"rejects",
			async () => {
				throw new Error("no locale")
			},
		],
	])("a resolveLocale that %s: the answer goes out untranslated, and a warn says why", async (_name, resolveLocale) => {
		const a = app(gone, resolveLocale)
		const res = await a.fetch(new Request("http://app.test/x"), { TENANT: "t" })
		expect([res.status, (await body(res)).message, a.lines.map((line) => [line.level, line.msg])]).toEqual([
			410,
			"item_gone",
			[[40, "error i18n failed"]],
		])
	})

	it("not set: the message stays the key, and the body never carries vars", async () => {
		const answer = await body(await app(gone).fetch(new Request("http://app.test/x"), { TENANT: "t" }))
		expect([answer.message, "vars" in answer]).toEqual(["item_gone", false])
	})

	it("the framework's own 404 and 405 are not translated", async () => {
		const a = app(gone, () => "de")
		const [missing, wrongMethod] = [
			await a.fetch(new Request("http://app.test/nowhere"), { TENANT: "t" }),
			await a.fetch(new Request("http://app.test/x", { method: "POST" }), { TENANT: "t" }),
		]
		expect([
			missing.status,
			(await body(missing)).message,
			wrongMethod.status,
			(await body(wrongMethod)).message,
		]).toEqual([404, "not_found", 405, "method_not_allowed"])
	})
})

describe("app.errorI18n with onError", () => {
	function withOnError(result: (error: unknown) => unknown) {
		const a = app(gone, () => "de")
		a.onError((error) => result(error) as never)
		return a
	}

	it("a HoneyError onError returns is translated in its turn", async () => {
		const answer = await body(
			await withOnError(() => new HoneyError({ errorKey: "item_gone", status: "gone", vars: { name: "Other" } })).fetch(
				new Request("http://app.test/x"),
				{ TENANT: "t" },
			),
		)
		expect(answer.message).toBe("Other ist weg")
	})

	it("onError sees the raw thrown error, and a Response it returns goes out as it is", async () => {
		const seen: unknown[] = []
		const res = await withOnError((error) => {
			seen.push(error)
			return new Response("custom", { status: 418 })
		}).fetch(new Request("http://app.test/x"), { TENANT: "t" })
		expect([res.status, await res.text(), (seen[0] as HoneyError).message]).toEqual([418, "custom", "item_gone"])
	})

	it("nothing returned: the thrown error's translated answer", async () => {
		const answer = await body(
			await withOnError(() => undefined).fetch(new Request("http://app.test/x"), { TENANT: "t" }),
		)
		expect(answer.message).toBe("Order 7 ist weg")
	})
})
