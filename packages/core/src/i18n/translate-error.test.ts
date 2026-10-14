/**
 * translateError against v0's own translations. Each row of translate-error.v0.json is an error a v0
 * suite answered with errorI18n on (the field paths its validation produced, the key and vars, the
 * configured translations and the resolved locale) and exactly what v0's translator made of it,
 * recorded by running those suites unchanged with a recording translator; `case` names the v0
 * case. v1 must agree on every row: the message, each field's display path, and whether nothing
 * changed (the same error back). The cases recorded:
 */
// v0: 506a4af4b7
// v0: b2eb9eccd6
// v0: 38fac19435
// v0: 4710aa35ae
// v0: 31ddfce4cc
// v0: 43131a7a20
// v0: 6861aa5803
// v0: d52c7070a2
// v0: 4dca9324d8
// v0: 54894c4b3b
// v0: b0cfdf04f1
// v0: 37a053d1c2
// v0: bb3df94a24
// v0: fbf8b9213d
// v0: 8e1e427879
// v0: 897b892c10
// v0: e8e81595f6
// v0: 66c00a9167
// v0: 251d20f792
// v0: 4ad452e983
// v0: d6f42f0c17
// v0: e93b44dd50
// v0: 93a5c51e4c
// v0: ce6dec0b9a
// v0: adccf98065
// v0: cecda267fb
// v0: e3afc9e519
// v0: 945dace406
// v0: 6185b6de4b
// v0: d0104b5a96
// v0: 2fa26d92e9
// v0: bdff50f741
// v0: 429d3f0e3f
// v0: 717a9b904b
// v0: eec5be3c7f
// v0: 6b7bfd4b0f
// v0: 211f158821
// v0: f83c28920e
// v0: ac90e71691
// v0: d95b2b044b
// v0: 96dc1af4f6
// v0: 49a823e88a
// v0: 4496179d35
// v0: b0e018dade
// v0: 6debd6b2fe
// v0: 3c47274c65
// v0: efc3e91c83
// v0: 8c571d55dd
// v0: c2b9785752
import { describe, expect, it } from "vitest"
import { HoneyError } from "../errors/error.ts"
import type { StatusKey } from "../response/status.ts"
import { type ErrorTranslations, translateError } from "./error-i18n.ts"
import recorded from "./translate-error.v0.json" with { type: "json" }

type Fields = Record<string, { error_key: string; message: string; path: string }[]>

type Row = {
	readonly case: string
	readonly error: { errorKey: string; fields: Fields; status: string; vars: Record<string, number | string> | null }
	readonly locale: string
	readonly out: { fields: Fields; message: string; same: boolean }
	readonly translations: ErrorTranslations
}

describe("translateError(): v0's recorded translations, row for row", () => {
	it.each(recorded as unknown as readonly Row[])(
		"$case: $error.errorKey in $locale",
		({ error, locale, out, translations }) => {
			const thrown = new HoneyError({
				errorKey: error.errorKey,
				fields: error.fields,
				status: error.status as StatusKey,
				...(error.vars === null ? {} : { vars: error.vars }),
			})
			const translated = translateError(thrown, translations, locale)
			expect([translated === thrown, translated.message, translated.fields]).toEqual([
				out.same,
				out.message,
				out.fields,
			])
		},
	)
})
