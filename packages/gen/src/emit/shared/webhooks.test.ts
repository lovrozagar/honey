import { describe, expect, it } from "vitest"
import { goString, pyString, rustString, tsString } from "./escape.ts"
import { signatureLiterals, verifyHelper, WEBHOOK_LANGUAGES, type WebhookLanguage } from "./webhooks.ts"

/** Each language's constant-time comparison: the only way its helper may compare a digest (H18.9). */
const CONSTANT_TIME: Readonly<Record<WebhookLanguage, RegExp>> = {
	csharp: /CryptographicOperations\.FixedTimeEquals\(expected, given\)/,
	go: /hmac\.Equal\(expected, given\)/,
	java: /MessageDigest\.isEqual\(expected, given\)/,
	python: /hmac\.compare_digest\(expected, given\)/,
	rust: /expected\.ct_eq\(&given\)/,
	ts: /timingSafeEqual\(expected, given\)/,
}

/* a digest compared any other way: an operator, a value equality or a byte-wise library compare */
const VARIABLE_TIME =
	/\b(?:expected|given)\b\s*(?:===?|!==?|\.equals\(|\.SequenceEqual\()|(?:===?|!==?)\s*\b(?:expected|given)\b|bytes\.Equal|Arrays\.equals|memcmp/

describe("verifyHelper: one HMAC-SHA256 verify helper per language", () => {
	it.each(WEBHOOK_LANGUAGES)("%s compares the digest in constant time, and never another way", (language) => {
		const helper = verifyHelper(language)
		expect([CONSTANT_TIME[language].test(helper), VARIABLE_TIME.exec(helper)?.[0] ?? null]).toEqual([true, null])
	})

	it("names the helper in each language's own style, taking the secret, the payload, the header value, the encoding and the prefix", () => {
		expect(
			WEBHOOK_LANGUAGES.map(
				(language) => /(?:function|func|fn|def|bool|boolean) (\w+)\(/.exec(verifyHelper(language))?.[1],
			),
		).toEqual([
			"VerifyWebhookSignature",
			"VerifyWebhookSignature",
			"verifyWebhookSignature",
			"verify_webhook_signature",
			"verify_webhook_signature",
			"verifyWebhookSignature",
		])
	})

	it("decodes hex and base64 and strips the prefix before comparing, refusing any other encoding", () => {
		for (const language of WEBHOOK_LANGUAGES) {
			const helper = verifyHelper(language)
			expect([helper.includes('"hex"'), helper.includes('"base64"'), /prefix/.test(helper)], language).toEqual([
				true,
				true,
				true,
			])
		}
	})
})

describe("signatureLiterals: a webhook's header and prefix as each target's literals", () => {
	it("writes both through the F2 escape layer, whatever they hold", () => {
		const signature = { algorithm: "hmac-sha256", encoding: "hex", header: "X-Signature", prefix: 'v1="\\\n' } as const
		expect((["go", "python", "rust", "ts"] as const).map((target) => signatureLiterals(target, signature))).toEqual([
			{ header: goString("X-Signature"), prefix: goString('v1="\\\n') },
			{ header: pyString("X-Signature"), prefix: pyString('v1="\\\n') },
			{ header: rustString("X-Signature"), prefix: rustString('v1="\\\n') },
			{ header: tsString("X-Signature"), prefix: tsString('v1="\\\n') },
		])
	})
})
