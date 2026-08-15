import { describe, expect, it } from "vitest"
import { HoneyError } from "../../../src/error.ts"
import type { NormalizedIssue } from "../../../src/types.ts"
import {
	issuesToFieldErrors,
	mapNormalizedCode,
	normalizeIssues,
	parseCookies,
	selectParser,
	validateInput,
	validateOutput,
} from "../../../src/validation.ts"

/* Minimal StandardSchema-like schema for testing */
function mockSchema(
	validate: (data: unknown) => {
		issues?: Array<{ message: string; path?: PropertyKey[] }>
		value?: unknown
	},
) {
	return {
		"~standard": {
			validate,
			vendor: "test",
			version: 1,
		},
	}
}

function okSchema<T>(transform?: (v: unknown) => T) {
	return mockSchema((data) => ({ value: transform ? transform(data) : data }))
}

function failSchema(issues: Array<{ message: string; path?: PropertyKey[] }>) {
	return mockSchema(() => ({ issues }))
}

describe("selectParser", () => {
	it("application/json → json", () => {
		expect(selectParser("application/json")).toBe("json")
	})

	it("application/json; charset=utf-8 → json", () => {
		expect(selectParser("application/json; charset=utf-8")).toBe("json")
	})

	it("multipart/form-data → form", () => {
		expect(selectParser("multipart/form-data; boundary=---")).toBe("form")
	})

	it("application/x-www-form-urlencoded → form", () => {
		expect(selectParser("application/x-www-form-urlencoded")).toBe("form")
	})

	it("unknown → null", () => {
		expect(selectParser("text/plain")).toBeNull()
	})

	it("null → null", () => {
		expect(selectParser(null)).toBeNull()
	})
})

describe("parseCookies", () => {
	it("parses Cookie header", () => {
		expect(parseCookies("a=1; b=2")).toEqual({ a: "1", b: "2" })
	})

	it("empty string → empty object", () => {
		expect(parseCookies("")).toEqual({})
	})

	it("handles spaces and special values", () => {
		expect(parseCookies("token=abc123; path=/api")).toEqual({
			path: "/api",
			token: "abc123",
		})
	})
})

describe("mapNormalizedCode", () => {
	it("required → field_required", () => {
		expect(mapNormalizedCode("required")).toBe("field_required")
	})

	it("too_short → field_too_short", () => {
		expect(mapNormalizedCode("too_short")).toBe("field_too_short")
	})

	it("too_small → field_too_small", () => {
		expect(mapNormalizedCode("too_small")).toBe("field_too_small")
	})

	it("too_long → field_too_long", () => {
		expect(mapNormalizedCode("too_long")).toBe("field_too_long")
	})

	it("too_big → field_too_big", () => {
		expect(mapNormalizedCode("too_big")).toBe("field_too_big")
	})

	it("invalid_format → field_invalid_email", () => {
		expect(mapNormalizedCode("invalid_format")).toBe("field_invalid_format")
	})

	it("invalid_value → field_invalid_enum", () => {
		expect(mapNormalizedCode("invalid_value")).toBe("field_invalid_enum")
	})

	it("unrecognized → field_unrecognized_keys", () => {
		expect(mapNormalizedCode("unrecognized")).toBe("field_unrecognized_keys")
	})

	it("not_multiple → field_not_multiple_of", () => {
		expect(mapNormalizedCode("not_multiple")).toBe("field_not_multiple_of")
	})

	it("unknown code → field_invalid (fallback)", () => {
		expect(mapNormalizedCode("something_else")).toBe("field_invalid")
	})
})

describe("issuesToFieldErrors", () => {
	it("maps normalized issues to FieldError records", () => {
		const issues: NormalizedIssue[] = [
			{ code: "required", message: "Email is required", meta: { field: "email" }, path: ["email"] },
		]
		const result = issuesToFieldErrors(issues, "json")
		expect(result.email).toHaveLength(1)
		expect(result.email[0].error_key).toBe("field_required")
		expect(result.email[0].path).toBe("json.email")
		expect(result.email[0].message).toBe("Email is required")
	})

	it("deeply nested path", () => {
		const issues: NormalizedIssue[] = [{ code: "required", message: "Required", meta: {}, path: ["address", "city"] }]
		const result = issuesToFieldErrors(issues, "json")
		expect(result.city).toHaveLength(1)
		expect(result.city[0].path).toBe("json.address.city")
	})
})

describe("validateInput", () => {
	it("JSON body parsing + schema validation → validated data", async () => {
		const schema = okSchema()
		const req = new Request("http://localhost/test", {
			body: JSON.stringify({ email: "test@example.com" }),
			headers: { "content-type": "application/json" },
			method: "POST",
		})
		const result = await validateInput({ json: schema }, req, {})
		expect(result.json).toEqual({ email: "test@example.com" })
	})

	it("JSON body with invalid data → HoneyError", async () => {
		const schema = failSchema([{ message: "Email is required", path: ["email"] }])
		const req = new Request("http://localhost/test", {
			body: JSON.stringify({}),
			headers: { "content-type": "application/json" },
			method: "POST",
		})

		try {
			await validateInput({ json: schema }, req, {})
			expect.fail("should throw")
		} catch (e) {
			expect(e).toBeInstanceOf(HoneyError)
			const err = e as HoneyError
			expect(err.errorKey).toBe("validation_failed")
			expect(err.status).toBe(400)
			expect(err.fields.email).toHaveLength(1)
		}
	})

	it("search param parsing", async () => {
		const schema = okSchema()
		const req = new Request("http://localhost/test?name=hello")
		const result = await validateInput({ search: schema }, req, {})
		expect(result.search).toEqual({ name: "hello" })
	})

	it("search param multi-value", async () => {
		const schema = okSchema()
		const req = new Request("http://localhost/test?tag=a&tag=b")
		const result = await validateInput({ search: schema }, req, {})
		expect(result.search).toEqual({ tag: ["a", "b"] })
	})

	it("param validation", async () => {
		const schema = okSchema()
		const req = new Request("http://localhost/test")
		const result = await validateInput({ params: schema }, req, { orgId: "abc-123" })
		expect(result.params).toEqual({ orgId: "abc-123" })
	})

	it("header validation — keys lowercased", async () => {
		const schema = okSchema()
		const req = new Request("http://localhost/test", {
			headers: { "X-Custom": "val" },
		})
		const result = await validateInput({ headers: schema }, req, {})
		expect(result.headers).toHaveProperty("x-custom", "val")
	})

	it("cookie parsing", async () => {
		const schema = okSchema()
		const req = new Request("http://localhost/test", {
			headers: { cookie: "session=abc; theme=dark" },
		})
		const result = await validateInput({ cookies: schema }, req, {})
		expect(result.cookies).toEqual({ session: "abc", theme: "dark" })
	})

	it("unknown Content-Type with body → 415", async () => {
		const schema = okSchema()
		const req = new Request("http://localhost/test", {
			body: "hello",
			headers: { "content-type": "text/plain" },
			method: "POST",
		})

		try {
			await validateInput({ json: schema }, req, {})
			expect.fail("should throw")
		} catch (e) {
			expect(e).toBeInstanceOf(HoneyError)
			expect((e as HoneyError).status).toBe(415)
		}
	})

	it("no Content-Type, no body → no error (GET request)", async () => {
		const schema = okSchema()
		const req = new Request("http://localhost/test?q=1")
		const result = await validateInput({ search: schema }, req, {})
		expect(result.search).toEqual({ q: "1" })
	})

	it("empty JSON body {} validated", async () => {
		const schema = okSchema()
		const req = new Request("http://localhost/test", {
			body: "{}",
			headers: { "content-type": "application/json" },
			method: "POST",
		})
		const result = await validateInput({ json: schema }, req, {})
		expect(result.json).toEqual({})
	})

	it("form urlencoded parsing", async () => {
		const schema = okSchema()
		const req = new Request("http://localhost/test", {
			body: "name=hello&age=25",
			headers: { "content-type": "application/x-www-form-urlencoded" },
			method: "POST",
		})
		const result = await validateInput({ form: schema }, req, {})
		expect(result.form).toEqual({ age: "25", name: "hello" })
	})
})

describe("vendor issue code extraction", () => {
	it("Zod issue code extracted", () => {
		const issues = [{ code: "too_small", message: "Too short", path: ["name"] }]
		const normalized = normalizeIssues(issues, "zod")
		expect(normalized[0].code).toBe("too_small")
	})

	it("Valibot issue type extracted", () => {
		const issues = [{ message: "Min length", path: ["name"], type: "min_length" }]
		const normalized = normalizeIssues(issues, "valibot")
		expect(normalized[0].code).toBe("min_length")
	})

	it("ArkType issue code extracted", () => {
		const issues = [{ code: "invalid_type", message: "Expected string", path: ["age"] }]
		const normalized = normalizeIssues(issues, "arktype")
		expect(normalized[0].code).toBe("invalid_type")
	})

	it("unknown vendor → unknown code", () => {
		const issues = [{ message: "Error", path: [] }]
		const normalized = normalizeIssues(issues, "custom-lib")
		expect(normalized[0].code).toBe("unknown")
	})

	it("Zod issue without code field → unknown", () => {
		const issues = [{ message: "Bad value" }]
		const normalized = normalizeIssues(issues, "zod")
		expect(normalized[0].code).toBe("unknown")
	})
})

describe("body-aware input parsing", () => {
	it("DELETE with json schema → body not parsed", async () => {
		const schema = okSchema()
		const req = new Request("http://localhost/test", {
			body: JSON.stringify({ name: "test" }),
			headers: { "content-type": "application/json" },
			method: "DELETE",
		})
		const result = await validateInput({ json: schema }, req, {})
		expect(result.json).toBeUndefined()
	})

	it("OPTIONS with json schema → body not parsed", async () => {
		const schema = okSchema()
		const req = new Request("http://localhost/test", {
			method: "OPTIONS",
		})
		const result = await validateInput({ json: schema }, req, {})
		expect(result.json).toBeUndefined()
	})

	it("HEAD with json schema → body not parsed", async () => {
		const schema = okSchema()
		const req = new Request("http://localhost/test", {
			method: "HEAD",
		})
		const result = await validateInput({ json: schema }, req, {})
		expect(result.json).toBeUndefined()
	})

	it("GET with json schema → body not parsed", async () => {
		const schema = okSchema()
		const req = new Request("http://localhost/test?q=1")
		const result = await validateInput({ json: schema, search: schema }, req, {})
		expect(result.json).toBeUndefined()
		expect(result.search).toEqual({ q: "1" })
	})

	it("POST with json schema → body parsed normally", async () => {
		const schema = okSchema()
		const req = new Request("http://localhost/test", {
			body: JSON.stringify({ name: "test" }),
			headers: { "content-type": "application/json" },
			method: "POST",
		})
		const result = await validateInput({ json: schema }, req, {})
		expect(result.json).toEqual({ name: "test" })
	})
})

describe("readableStream runtime handling", () => {
	it("readableStream for json → body not consumed", async () => {
		const failOnValidate = failSchema([{ message: "Would fail" }])
		const wrapped = { _tag: "readableStream" as const, schema: failOnValidate }
		const req = new Request("http://localhost/test", {
			body: JSON.stringify({ name: "raw" }),
			headers: { "content-type": "application/json" },
			method: "POST",
		})
		const result = await validateInput({ json: wrapped }, req, {})
		/* body not consumed — json is undefined */
		expect(result.json).toBeUndefined()
		/* body is still readable */
		const body = (await req.json()) as Record<string, unknown>
		expect(body.name).toBe("raw")
	})

	it("readableStream for form → body not consumed", async () => {
		const failOnValidate = failSchema([{ message: "Would fail" }])
		const wrapped = { _tag: "readableStream" as const, schema: failOnValidate }

		const formData = new FormData()
		formData.set("name", "Alice")

		const req = new Request("http://localhost/test", {
			body: formData,
			method: "POST",
		})
		const result = await validateInput({ form: wrapped }, req, {})
		/* body not consumed — form is undefined */
		expect(result.form).toBeUndefined()
		/* body is still readable */
		const fd = await req.formData()
		expect(fd.get("name")).toBe("Alice")
	})

	it("readableStream for search → passes raw without validation", async () => {
		const failOnValidate = failSchema([{ message: "Would fail" }])
		const wrapped = { _tag: "readableStream" as const, schema: failOnValidate }
		const req = new Request("http://localhost/test?page=1")
		const result = await validateInput({ search: wrapped }, req, {})
		expect(result.search).toEqual({ page: "1" })
	})

	it("readableStream for params → passes raw without validation", async () => {
		const failOnValidate = failSchema([{ message: "Would fail" }])
		const wrapped = { _tag: "readableStream" as const, schema: failOnValidate }
		const req = new Request("http://localhost/test")
		const result = await validateInput({ params: wrapped }, req, { id: "abc" })
		expect(result.params).toEqual({ id: "abc" })
	})

	it("standard schema still validates normally", async () => {
		const schema = failSchema([{ message: "Invalid", path: ["email"] }])
		const req = new Request("http://localhost/test", {
			body: JSON.stringify({ email: "bad" }),
			headers: { "content-type": "application/json" },
			method: "POST",
		})

		try {
			await validateInput({ json: schema }, req, {})
			expect.fail("should throw")
		} catch (e) {
			expect(e).toBeInstanceOf(HoneyError)
			expect((e as HoneyError).errorKey).toBe("validation_failed")
		}
	})
})

describe("validateOutput", () => {
	it("valid data → no error", async () => {
		const validator = okSchema()
		await expect(validateOutput(validator, "ok", { id: 1 })).resolves.toBeUndefined()
	})

	it("invalid data → HoneyError 500", async () => {
		const validator = failSchema([{ message: "bad output" }])
		try {
			await validateOutput(validator, "ok", { bad: true })
			expect.fail("should throw")
		} catch (e) {
			expect(e).toBeInstanceOf(HoneyError)
			expect((e as HoneyError).status).toBe(500)
		}
	})

	it("error includes statusKey for debugging", async () => {
		const validator = failSchema([{ message: "bad shape" }])
		try {
			await validateOutput(validator, "created", { wrong: true })
			expect.fail("should throw")
		} catch (e) {
			expect(e).toBeInstanceOf(HoneyError)
			const err = e as HoneyError
			expect(err.errorKey).toBe("output_validation_failed")
			expect(err.vars).toBeDefined()
			expect(err.vars?.statusKey).toBe("created")
		}
	})
})

describe("prototype pollution guard", () => {
	it("__proto__ form field silently dropped", async () => {
		const schema = okSchema()
		const formData = new FormData()
		formData.set("name", "Alice")
		formData.set("__proto__", "polluted")
		const req = new Request("http://localhost/test", {
			body: formData,
			method: "POST",
		})
		const result = await validateInput({ form: schema }, req, {})
		const form = result.form as Record<string, unknown>
		expect(form.name).toBe("Alice")
		expect(Object.hasOwn(form, "__proto__")).toBe(false)
	})

	it("constructor form field silently dropped", async () => {
		const schema = okSchema()
		const formData = new FormData()
		formData.set("name", "Bob")
		formData.set("constructor", "evil")
		const req = new Request("http://localhost/test", {
			body: formData,
			method: "POST",
		})
		const result = await validateInput({ form: schema }, req, {})
		const form = result.form as Record<string, unknown>
		expect(form.name).toBe("Bob")
		expect(Object.hasOwn(form, "constructor")).toBe(false)
	})

	it("prototype form field silently dropped", async () => {
		const schema = okSchema()
		const formData = new FormData()
		formData.set("prototype", "evil")
		formData.set("safe", "ok")
		const req = new Request("http://localhost/test", {
			body: formData,
			method: "POST",
		})
		const result = await validateInput({ form: schema }, req, {})
		const form = result.form as Record<string, unknown>
		expect(form.safe).toBe("ok")
		expect(Object.hasOwn(form, "prototype")).toBe(false)
	})

	it("normal fields unaffected", async () => {
		const schema = okSchema()
		const formData = new FormData()
		formData.set("email", "test@test.com")
		formData.set("proto_type", "not dangerous")
		const req = new Request("http://localhost/test", {
			body: formData,
			method: "POST",
		})
		const result = await validateInput({ form: schema }, req, {})
		const form = result.form as Record<string, unknown>
		expect(form.email).toBe("test@test.com")
		expect(form.proto_type).toBe("not dangerous")
	})

	it("field named my__proto__field NOT blocked (exact match only)", async () => {
		const schema = okSchema()
		const formData = new FormData()
		formData.set("my__proto__field", "safe")
		const req = new Request("http://localhost/test", {
			body: formData,
			method: "POST",
		})
		const result = await validateInput({ form: schema }, req, {})
		const form = result.form as Record<string, unknown>
		expect(form.my__proto__field).toBe("safe")
	})

	it("urlencoded form also guarded", async () => {
		const schema = okSchema()
		const req = new Request("http://localhost/test", {
			body: "__proto__=evil&name=ok",
			headers: { "content-type": "application/x-www-form-urlencoded" },
			method: "POST",
		})
		const result = await validateInput({ form: schema }, req, {})
		const form = result.form as Record<string, unknown>
		expect(form.name).toBe("ok")
		expect(Object.hasOwn(form, "__proto__")).toBe(false)
	})

	it("consumer: form POST with __proto__ → no Object.prototype pollution", async () => {
		const originalHasOwn = Object.prototype.hasOwnProperty
		const schema = okSchema()
		const formData = new FormData()
		formData.set("__proto__", JSON.stringify({ polluted: true }))
		formData.set("normal", "value")
		const req = new Request("http://localhost/test", {
			body: formData,
			method: "POST",
		})
		await validateInput({ form: schema }, req, {})
		/* verify Object.prototype was not polluted */
		expect(({} as Record<string, unknown>).polluted).toBeUndefined()
		expect(Object.prototype.hasOwnProperty).toBe(originalHasOwn)
	})
})
