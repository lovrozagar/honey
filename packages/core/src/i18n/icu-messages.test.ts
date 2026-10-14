/**
 * The ICU engine on whole messages, against v0's own answers (as in icu.test.ts): nesting and
 * mixing, simple vars and the template's structure, malformed input, and keys from data. Each row
 * is an input a v0 suite gave `interpolate` and the exact string v0 returned for it.
 */
import { describe, expect, it } from "vitest"
import { interpolate } from "./icu.ts"

type Row = readonly [template: string, vars: Record<string, unknown>, locale: string | undefined, expected: string]

const NESTED: readonly Row[] = [
	// v0: 8e02e6c48c
	[
		"{n, plural, one {# of {n, plural, one {# kind} other {# kinds}}} other {# of {n, plural, one {# kind} other {# kinds}}}}",
		{ n: 1 },
		undefined,
		"1 of 1 kind",
	],
	// v0: da445dc37a
	[
		"{n, plural, one {# of {n, plural, one {# kind} other {# kinds}}} other {# of {n, plural, one {# kind} other {# kinds}}}}",
		{ n: 5 },
		undefined,
		"5 of 5 kinds",
	],
	// v0: b59cd9dfac
	["{x, select, a {{x, select, a {{x}} other {no}}} other {no}}", { x: "a" }, undefined, "a"],
	// v0: 6611b29268
	["{a}{b, number}{c, plural, one {#} other {#s}}", { a: "X", b: 1000, c: 2 }, "en", "X1,0002s"],
	// v0: 70586576a3
	[
		"Price: {price, number} — {status, select, sale {ON SALE} other {regular}} — {stock, plural, =0 {out of stock} one {# left} other {# left}}",
		{ price: 29.99, status: "sale", stock: 3 },
		"en",
		"Price: 29.99 — ON SALE — 3 left",
	],
	// v0: 93d7fcb3fb
	[
		"User {name} spent {amount, number} on {items, plural, one {# item} other {# items}}",
		{ amount: 1500, items: 1, name: "Alice" },
		"en",
		"User Alice spent 1,500 on 1 item",
	],
	// v0: d0fdd81f01
	[
		"Hello {name}, you have {count, plural, one {# message} other {# messages}}",
		{ count: 0, name: "Bob" },
		undefined,
		"Hello Bob, you have 0 messages",
	],
	// v0: 990e84a94e
	[
		"{a, select, x {{b, select, y {{c, select, z {{d}} other {?}}} other {?}}} other {?}}",
		{ a: "x", b: "y", c: "z", d: "DEEP" },
		undefined,
		"DEEP",
	],
	// v0: 543d8a32cb
	[
		"{files, plural, one {# file} other {# files}} and {folders, plural, one {# folder} other {# folders}}",
		{ files: 1, folders: 3 },
		undefined,
		"1 file and 3 folders",
	],
	// v0: 26eca6f55f
	[
		"{a, select, x {{b, select, y {{c, select, z {{d}} other {fallback}}} other {?}}} other {?}}",
		{ a: "x", b: "y", c: "wrong", d: "DEEP" },
		undefined,
		"fallback",
	],
	// v0: cb39e120d4
	[
		"{gender, select, male {Mr.} female {Ms.} other {Mx.}} {name}",
		{ gender: "female", name: "Smith" },
		undefined,
		"Ms. Smith",
	],
	// v0: 783e5eeb8a
	[
		"{count, plural, one {# résultat trouvé} other {# résultats trouvés}}",
		{ count: 1 },
		undefined,
		"1 résultat trouvé",
	],
	// v0: bc27554428
	[
		"{gender, select, male {Estimado} female {Estimada} other {Estimado/a}} {name}, tiene {count, plural, one {# mensaje nuevo} other {# mensajes nuevos}}",
		{ count: 5, gender: "female", name: "María" },
		undefined,
		"Estimada María, tiene 5 mensajes nuevos",
	],
	// v0: 0246605ade
	["{count, plural, other {# عنصر}}", { count: 42 }, undefined, "42 عنصر"],
	// v0: c8bf848eee
	["{count, plural, other {{count}个错误}}已修复", { count: 3 }, undefined, "3个错误已修复"],
	// v0: 2c8e379a99
	[
		"Are you sure you want to delete {count, plural, one {this {type}} other {these # {type}s}}?",
		{ count: 5, type: "document" },
		undefined,
		"Are you sure you want to delete these 5 documents?",
	],
	// v0: ad99d4b375
	[
		"{role, select, admin {관리자} member {회원} other {방문자}}님 환영합니다",
		{ role: "admin" },
		undefined,
		"관리자님 환영합니다",
	],
	// v0: a4fa2b6eab
	[
		"Are you sure you want to delete {count, plural, one {this {type}} other {these # {type}s}}?",
		{ count: 1, type: "file" },
		undefined,
		"Are you sure you want to delete this file?",
	],
	// v0: 438b94be3b
	[
		"{time, select, morning {Good morning} afternoon {Good afternoon} evening {Good evening} other {Hello}}, {name}!",
		{ name: "Alice", time: "afternoon" },
		undefined,
		"Good afternoon, Alice!",
	],
	// v0: 004d9d6926
	[
		"{count, plural, one {# Validierungsfehler} other {# Validierungsfehler}} in {field}",
		{ count: 3, field: "E-Mail-Adresse" },
		undefined,
		"3 Validierungsfehler in E-Mail-Adresse",
	],
	// v0: 35e9228b99
	[
		"{count, plural, one {# field needs} other {# fields need}} correction. Please review {count, plural, one {it} other {them}}.",
		{ count: 3 },
		undefined,
		"3 fields need correction. Please review them.",
	],
	// v0: 3a87face20
	[
		"{count, plural, one {# field needs} other {# fields need}} correction. Please review {count, plural, one {it} other {them}}.",
		{ count: 1 },
		undefined,
		"1 field needs correction. Please review it.",
	],
	// v0: 54cb7689b0
	[
		"You have used {used, number} of {total, number} GB. {remaining, plural, =0 {Storage full!} one {# GB remaining.} other {# GB remaining.}}",
		{ remaining: 0, total: 100, used: 100 },
		"en",
		"You have used 100 of 100 GB. Storage full!",
	],
	// v0: a19d2f9952
	[
		"{sender} sent you {count, plural, one {a message} other {# messages}}",
		{ count: 7, sender: "Bob" },
		undefined,
		"Bob sent you 7 messages",
	],
	// v0: 3d679865f3
	[
		"Error {code}: {action, select, retry {Please try again in {seconds, plural, one {# second} other {# seconds}}} contact {Contact support at {email}} other {An error occurred}}",
		{ action: "retry", code: "E429", email: "help@test.com", seconds: 30 },
		undefined,
		"Error E429: Please try again in 30 seconds",
	],
	// v0: f940801298
	[
		"{role, select, admin {You can {action} all {resource, plural, one {# {type}} other {# {type}s}}} member {You can {action} your own {type}s} other {Access denied}}",
		{ action: "edit", resource: 5, role: "admin", type: "project" },
		undefined,
		"You can edit all 5 projects",
	],
	// v0: 240cfcac84
	[
		"{count, plural, one {{gender, select, male {He has} female {She has} other {They have}} # item} other {{gender, select, male {He has} female {She has} other {They have}} # items}}",
		{ count: 1, gender: "female" },
		undefined,
		"She has 1 item",
	],
	// v0: 1793fe6177
	[
		"{a, plural, one {# file in {b, plural, one {# folder} other {# folders}}} other {# files in {b, plural, one {# folder} other {# folders}}}}",
		{ a: 3, b: 1 },
		undefined,
		"3 files in 3 folder",
	],
	// v0: 8eb05d24f7
	["{a, select, x {{b, select, y {{c}} other {nope}}} other {no}}", { a: "x", b: "y", c: "deep" }, undefined, "deep"],
	// v0: 0a82bfd6c4
	[
		"Dear {gender, select, male {Mr.} female {Ms.} other {Mx.}} {name}, you have {count, plural, =0 {no new messages} one {# new message} other {# new messages}}.",
		{ count: 0, gender: "male", name: "Smith" },
		undefined,
		"Dear Mr. Smith, you have no new messages.",
	],
	// v0: a177ae6c97
	[
		"{field} must be at least {min, plural, one {# character} other {# characters}} long",
		{ field: "Password", min: 8 },
		undefined,
		"Password must be at least 8 characters long",
	],
	// v0: b3c5eb8a61
	[
		"You can select {max, plural, one {up to # item} other {up to # items}}",
		{ max: 1 },
		undefined,
		"You can select up to 1 item",
	],
	// v0: c348df6201
	[
		"Rate limited: {count}/{limit} {limit, plural, one {request} other {requests}} in {window} seconds",
		{ count: 150, limit: 100, window: 60 },
		undefined,
		"Rate limited: 150/100 requests in 60 seconds",
	],
	// v0: 4f42e06cc5
	[
		"{role, select, guest {Please sign in to continue} member {You need admin access} other {Access denied}}",
		{ role: "member" },
		undefined,
		"You need admin access",
	],
	// v0: 8b0a96baf4
	[
		"File too large: {size}MB exceeds {limit}MB limit. {count, plural, one {# file} other {# files}} rejected.",
		{ count: 3, limit: 10, size: 25 },
		undefined,
		"File too large: 25MB exceeds 10MB limit. 3 files rejected.",
	],
	// v0: 4143cf5a93
	[
		"Your {plan} plan includes {seats, plural, one {# seat} other {# seats}}. {remaining, plural, =0 {No seats remaining} one {# seat remaining} other {# seats remaining}}.",
		{ plan: "Pro", remaining: 0, seats: 5 },
		undefined,
		"Your Pro plan includes 5 seats. No seats remaining.",
	],
	// v0: fac4b1a17d
	["{count, plural, one {# Fehler} other {# Fehler}} gefunden", { count: 3 }, undefined, "3 Fehler gefunden"],
	// v0: 1dd21f7bc8
	["{count, plural, other {#件のエラー}}が見つかりました", { count: 5 }, undefined, "5件のエラーが見つかりました"],
]

const SIMPLE: readonly Row[] = [
	// v0: 46c7c98d41
	["{my var}", { "my var": "works" }, undefined, "works"],
	// v0: 1f79159c0a
	["{a.b}", { "a.b": "dotted" }, undefined, "dotted"],
	// v0: a127a0f6a3
	["{my-var}", { "my-var": "hyphen" }, undefined, "hyphen"],
	// v0: 958fb3d8e2
	["{0}", { "0": "zero" }, undefined, "zero"],
	// v0: 92a4782be0
	["{}", {}, undefined, "{}"],
	// v0: 2c825c54e0
	["{x}", { x: null }, undefined, "{x}"],
	// v0: dcaeb30cc0
	["{x}", { x: undefined }, undefined, "{x}"],
	// v0: 3bd54ec5ec
	["{x}", { x: false }, undefined, "false"],
	// v0: fb358d1ccc
	["{x}", { x: 0 }, undefined, "0"],
	// v0: ced859f7f0
	["{x}", { x: "" }, undefined, ""],
	// v0: 84e6ce49c4
	["{plural}", { plural: "just-a-value" }, undefined, "just-a-value"],
	// v0: 856a87c8f7
	["{select}", { select: "just-a-value" }, undefined, "just-a-value"],
	// v0: 69faf6f570
	["{number}", { number: "just-a-value" }, undefined, "just-a-value"],
	// v0: c5829f7622
	["{other}", { other: "just-a-value" }, undefined, "just-a-value"],
	// v0: 70fad01b34
	["{one}", { one: "just-a-value" }, undefined, "just-a-value"],
	// v0: e63fbe5390
	["{x, select, plural {matched plural} other {nope}}", { x: "plural" }, undefined, "matched plural"],
	// v0: e63f3bd44a
	["{x, select, a {   } other {b}}", { x: "a" }, undefined, "   "],
	// v0: cc4da2dbc0
	["{n, plural, other {#}}", { n: 99 }, undefined, "99"],
	// v0: cd01a38845
	["{x, select, a {} other {fallback}}", { x: "a" }, undefined, ""],
	// v0: 746a13751a
	["{x, select, a {[value] (ok) <done>} other {no}}", { x: "a" }, undefined, "[value] (ok) <done>"],
	// v0: a4d4f114b3
	[
		"{x, select, link {https://example.com/path?q=1&r=2} other {no}}",
		{ x: "link" },
		undefined,
		"https://example.com/path?q=1&r=2",
	],
	// v0: 522f9dfd6d
	['{x, select, json {value: "test"} other {no}}', { x: "json" }, undefined, 'value: "test"'],
	// v0: 3275acd5ba
	["{x, select, fire {🔥🔥🔥} other {meh}}", { x: "fire" }, undefined, "🔥🔥🔥"],
	// v0: 84df310f6a
	["{n,plural,one{#}other{#s}}", { n: 1 }, undefined, "1"],
	// v0: 0305b40aec
	["{field} is required", { field: "Email" }, undefined, "Email is required"],
	// v0: b4d2748bf2
	["{  n  ,  plural  ,  one  {single}  other  {multi}  }", { n: 1 }, undefined, "single"],
	// v0: 65cc5ae74d
	["{x, select, a {line1\nline2} other {no}}", { x: "a" }, undefined, "line1\nline2"],
	// v0: b3b39998d4
	["{a} and {b}", { a: "X", b: "Y" }, undefined, "X and Y"],
	// v0: b54e4fb798
	["{x, select, a {\tindented} other {no}}", { x: "a" }, undefined, "\tindented"],
	// v0: e7efab1db2
	["No variables here", {}, undefined, "No variables here"],
	// v0: e99d311248
	["{  name  }", { name: "trimmed" }, undefined, "trimmed"],
	// v0: 30e4e665da
	["42", {}, undefined, "42"],
	// v0: 90e39f6e7c
	["Hello World!", {}, undefined, "Hello World!"],
	// v0: 7b88b30fae
	["   ", {}, undefined, "   "],
	// v0: bb9e02281b
	["{name}🔥", { name: "fire" }, undefined, "fire🔥"],
	// v0: 5a39f0d055
	["<b>{x}</b>", { x: "bold" }, undefined, "<b>bold</b>"],
	// v0: 5696de7f8e
	["", {}, undefined, ""],
	// v0: f1912f7bc5
	["{a, plural, one {#} other {#s}}{b, plural, one {#} other {#s}}", { a: 1, b: 2 }, undefined, "12s"],
	// v0: 7ca32969a4
	["{count} items", { count: 0 }, undefined, "0 items"],
	// v0: e7f606639a
	["{n, plural, other {#}} items", { n: 3 }, undefined, "3 items"],
	// v0: f7e66a0eb9
	["total: {n, plural, other {#}}", { n: 7 }, undefined, "total: 7"],
	// v0: 13176a810a
	["{missing} here", {}, undefined, "{missing} here"],
	// v0: 3d672649d9
	["'{x}'", { x: "val" }, undefined, "'val'"],
]

const MALFORMED: readonly Row[] = [
	// v0: d0220dcfde
	["{{{{}}}}", {}, undefined, "{{{{}}}}"],
	// v0: 35ec069375
	["{unclosed", {}, undefined, "{unclosed"],
	// v0: de05193048
	["{}", {}, undefined, "{}"],
	// v0: a2d133e375
	["{x}", { x: "<script>alert(1)</script>" }, undefined, "<script>alert(1)</script>"],
	// v0: f1f33b6bf4
	["{n,plural,one{#}other{#s}}", { n: 1 }, undefined, "1"],
	// v0: 9a0f61189e
	[
		"{type, select, summary {{count, plural, one {# item} other {# items}} total} other {details}}",
		{ count: 5, type: "summary" },
		undefined,
		"5 items total",
	],
	// v0: 8b04a424f7
	["just text", {}, undefined, "just text"],
	// v0: 7e37eed9fe
	["text {", {}, undefined, "text {"],
	// v0: efb31c4b1f
	["text { {x}", { x: "val" }, undefined, "text { {x}"],
	// v0: e89db41931
	["", {}, undefined, ""],
	// v0: 8e1b929e44
	["{x}", { x: "only" }, undefined, "only"],
	// v0: 4b168627f6
	["{ x }", { x: "trimmed" }, undefined, "trimmed"],
	// v0: fa4dadcb7c
	["{x, date}", { x: "2026-01-01" }, undefined, "2026-01-01"],
	// v0: 0a33effbca
	["{x, custom, a {A} b {B}}", { x: "val" }, undefined, "val"],
	// v0: 7ab1b514c1
	["{a, plural, one {#} other {#s}}{b, plural, one {#} other {#s}}", { a: 1, b: 2 }, undefined, "12s"],
	// v0: 982772d49d
	["{a, plural, one {#} other {#s}} and {b, plural, one {#} other {#s}}", { a: 1, b: 2 }, undefined, "1 and 2s"],
	// v0: 6afce31bda
	["{x, select, a {it's <b>bold</b>!} other {nope}}", { x: "a" }, undefined, "it's <b>bold</b>!"],
	// v0: 36128785aa
	["{x}", { x: undefined }, undefined, "{x}"],
	// v0: a4c400ee0b
	["{x}", { x: true }, undefined, "true"],
]

const PROTOTYPE: readonly Row[] = [
	// v0: f89daf6cc2
	["{role, select, admin{Admin} other{User}}", { role: "constructor" }, undefined, "User"],
	["{role, select, admin{Admin} other{User}}", { role: "toString" }, undefined, "User"],
	["{role, select, admin{Admin} other{User}}", { role: "__proto__" }, undefined, "User"],
	["{role, select, admin{Admin} other{User}}", { role: "hasOwnProperty" }, undefined, "User"],
	["{role, select, admin{Admin} other{User}}", { role: "valueOf" }, undefined, "User"],
	// v0: e1dce2f9e6
	["{k, select, constructor{ctor} other{x}}", { k: "constructor" }, undefined, "ctor"],
	// v0: 37a496703e
	["{constructor} {toString}", {}, undefined, "{constructor} {toString}"],
]

describe("interpolate(): nesting and mixing: blocks inside blocks, real messages", () => {
	it.each(NESTED)("%j with %j in %s", (template, vars, locale, expected) => {
		expect(interpolate(template, vars, locale)).toBe(expected)
	})
})

describe("interpolate(): simple vars: names, whitespace, branch content, the template's structure", () => {
	it.each(SIMPLE)("%j with %j in %s", (template, vars, locale, expected) => {
		expect(interpolate(template, vars, locale)).toBe(expected)
	})
})

describe("interpolate(): malformed input: unbalanced braces and odd values pass through, never throw", () => {
	it.each(MALFORMED)("%j with %j in %s", (template, vars, locale, expected) => {
		expect(interpolate(template, vars, locale)).toBe(expected)
	})
})

describe("interpolate(): keys from data never reach Object.prototype", () => {
	it.each(PROTOTYPE)("%j with %j in %s", (template, vars, locale, expected) => {
		expect(interpolate(template, vars, locale)).toBe(expected)
	})
})

describe("interpolate(): a branch list that stops making sense ends there, as in v0", () => {
	it.each([
		["{n, plural, one two {x} other {y}}", ""],
		["{n, plural, one {x} stray}", "x"],
		["{n, select, a b {x} other {y}}", ""],
	])("%j → %j", (template, expected) => {
		expect(interpolate(template, { n: 1 })).toBe(expected)
	})
})
