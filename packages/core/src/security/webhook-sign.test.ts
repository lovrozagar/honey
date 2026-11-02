import { createHmac } from "node:crypto"
import { Webhook } from "standardwebhooks"
import { describe, expect, it } from "vitest"
import { signWebhook } from "./webhook.ts"

const KEY = Buffer.from("k".repeat(32)).toString("base64")
const SECRET = `whsec_${KEY}`
const OTHER = Buffer.from("o".repeat(32)).toString("base64")
const ID = "msg_1"
const BODY = '{"event":"paid"}'

const now = () => Math.floor(Date.now() / 1000)

function hmac(content: Buffer, key = KEY): string {
	return `v1,${createHmac("sha256", Buffer.from(key, "base64")).update(content).digest("base64")}`
}

describe("signWebhook against the official library", () => {
	it("signs a string body it verifies", async () => {
		const headers = await signWebhook({ body: BODY, id: ID, secrets: SECRET, timestamp: now() })
		expect(new Webhook(SECRET).verify(BODY, headers)).toEqual({ event: "paid" })
	})

	it("signs UTF-8 bytes it verifies", async () => {
		const bytes = new TextEncoder().encode(BODY)
		const headers = await signWebhook({ body: bytes, id: ID, secrets: SECRET, timestamp: now() })
		expect(new Webhook(SECRET).verify(Buffer.from(bytes), headers)).toEqual({ event: "paid" })
	})

	it("signs under each rotated secret, either verifying alone", async () => {
		const headers = await signWebhook({ body: BODY, id: ID, secrets: [SECRET, OTHER], timestamp: now() })
		expect(new Webhook(SECRET).verify(BODY, headers)).toEqual({ event: "paid" })
		expect(new Webhook(OTHER).verify(BODY, headers)).toEqual({ event: "paid" })
	})

	it("takes a secret with no prefix", async () => {
		const headers = await signWebhook({ body: BODY, id: ID, secrets: KEY, timestamp: now() })
		expect(new Webhook(SECRET).verify(BODY, headers)).toEqual({ event: "paid" })
	})

	it("is refused once anything signed is changed", async () => {
		const timestamp = now()
		const headers = await signWebhook({ body: BODY, id: ID, secrets: SECRET, timestamp })
		const hook = new Webhook(SECRET)
		const refused = "No matching signature found"
		expect(() => hook.verify('{"event":"free"}', headers)).toThrow(refused)
		expect(() => hook.verify(BODY, { ...headers, "webhook-id": "msg_2" })).toThrow(refused)
		expect(() => hook.verify(BODY, { ...headers, "webhook-timestamp": String(timestamp + 1) })).toThrow(refused)
	})

	it("matches the scheme's published example byte for byte", async () => {
		const headers = await signWebhook({
			body: '{"test": 2432232314}',
			id: "msg_p5jXN8AQM9LWM0D4loKWxJek",
			secrets: "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw",
			timestamp: 1_614_265_330,
		})
		expect(headers).toEqual({
			"webhook-id": "msg_p5jXN8AQM9LWM0D4loKWxJek",
			"webhook-signature": "v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=",
			"webhook-timestamp": "1614265330",
		})
	})
})

describe("signWebhook's bytes, against a plain HMAC", () => {
	const content = (body: Uint8Array) => Buffer.concat([Buffer.from(`${ID}.5.`), body])

	it("signs bytes that are not UTF-8 unchanged", async () => {
		const body = new Uint8Array([0xff, 0xfe, 0x00, 0x80])
		const headers = await signWebhook({ body, id: ID, secrets: SECRET, timestamp: 5 })
		expect(headers["webhook-signature"]).toBe(hmac(content(body)))
	})

	it("signs only the bytes a view shows", async () => {
		const body = new Uint8Array([9, 1, 2, 3, 9]).subarray(1, 4)
		const headers = await signWebhook({ body, id: ID, secrets: SECRET, timestamp: 5 })
		expect(headers["webhook-signature"]).toBe(hmac(content(new Uint8Array([1, 2, 3]))))
	})

	it("joins one signature per secret with a space, in the order given", async () => {
		const body = new Uint8Array([1])
		const headers = await signWebhook({ body, id: ID, secrets: [OTHER, SECRET], timestamp: 5 })
		expect(headers["webhook-signature"]).toBe(`${hmac(content(body), OTHER)} ${hmac(content(body))}`)
	})
})

describe("signWebhook refuses what could never verify", () => {
	const options = { body: BODY, id: ID, secrets: SECRET, timestamp: 1 }
	const sized = (bytes: number) => Buffer.alloc(bytes, 1).toString("base64")

	it.each([
		["no secret", []],
		["a secret of 23 bytes", sized(23)],
		["a secret of 65 bytes", sized(65)],
		["one bad secret in a list", [SECRET, sized(1)]],
		["a secret that is not base64", "not base64!"],
	])("%s", async (_name, secrets) => {
		await expect(signWebhook({ ...options, secrets })).rejects.toThrow(TypeError)
	})

	it("takes the longest and shortest secret", async () => {
		await expect(signWebhook({ ...options, secrets: [sized(24), sized(64)] })).resolves.toBeDefined()
	})

	it("never echoes a secret in its error", async () => {
		await expect(signWebhook({ ...options, secrets: "not base64!" })).rejects.not.toThrow("not base64!")
		await expect(signWebhook({ ...options, secrets: sized(1) })).rejects.not.toThrow(sized(1))
	})

	it.each([[1.5], [-1], [Number.NaN], [Number.POSITIVE_INFINITY], [1e21]])("a timestamp of %s", async (timestamp) => {
		await expect(signWebhook({ ...options, timestamp })).rejects.toThrow(TypeError)
	})

	it.each([[""], ["a b"], ["a\nb"], ["a\rb"], ["a\u0000b"]])("an id of %j", async (id) => {
		await expect(signWebhook({ ...options, id })).rejects.toThrow(TypeError)
	})
})
