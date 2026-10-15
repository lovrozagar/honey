/**
 * Gen's adversarial suite: spec text an emitter must never let become source. A string literal
 * carrying a line or paragraph separator, a BOM or NUL; property names and enum values that read as
 * code; names whose order depends on the machine; a webhook verify helper that compares the
 * signature by value, so its timing leaks how much of a forged one is right. Each is a failing input first and the property
 * that answers it second; the gen mutation harness reruns this directory with each guard disabled.
 */
import { resolve } from "node:path"
import { Project } from "ts-morph"
import { describe, expect, it, vi } from "vitest"
import { guardNamed } from "../structure/mutation-harness.ts"

const REPO = resolve(import.meta.dirname, "../../../..")

const mutant = guardNamed(process.env.HONEY_MUTANT)
if (mutant !== undefined) {
	vi.doMock(resolve(REPO, mutant.module), async (importOriginal) => {
		const original = await importOriginal<Record<string, unknown>>()
		return { ...original, ...mutant.disable(original) }
	})
}

/* imported after the mock, so a mutant reaches every module that uses it */
const { commentProblem, failures, literalProblem, TARGETS } = (await import(
	resolve(REPO, "packages/gen/src/emit/shared/__fixtures__/escape-oracle.ts")
)) as typeof import("../../src/emit/shared/__fixtures__/escape-oracle.ts")
const { irToTs } = (await import(
	resolve(REPO, "packages/gen/src/emit/shared/type-emitter.ts")
)) as typeof import("../../src/emit/shared/type-emitter.ts")
const { schemaToIR } = (await import(
	resolve(REPO, "packages/gen/src/ir/model.ts")
)) as typeof import("../../src/ir/model.ts")
const { verifyHelper, WEBHOOK_LANGUAGES } = (await import(
	resolve(REPO, "packages/gen/src/emit/shared/webhooks.ts")
)) as typeof import("../../src/emit/shared/webhooks.ts")

/** The TypeScript of a JSON Schema, as an emitter writes it. */
const typeOf = (schema: Record<string, unknown>) => irToTs(schemaToIR(schema))

/** `type T = <text>` parsed and checked: its syntax errors, its member names and its union's literal values. */
function compiled(text: string): { errors: string[]; members: string[]; values: unknown[] } {
	const project = new Project({ compilerOptions: { strict: true }, useInMemoryFileSystem: true })
	const file = project.createSourceFile("/t.ts", `export type T = ${text}\n`)
	const type = file.getTypeAliasOrThrow("T").getType()
	return {
		errors: file.getPreEmitDiagnostics().map((d) => String(d.getMessageText())),
		members: type.getProperties().map((p) => p.getName()),
		values: type.isUnion() ? type.getUnionTypes().map((t) => t.getLiteralValue()) : [],
	}
}

describe("gen adversarial: a string literal", () => {
	it("never carries U+2028, U+2029, NEL, the BOM or NUL raw, nor an escape its target cannot read", () => {
		const texts = ["a b", "a b", "a\u0085b", "﻿bom", "nul\0", "\u007f", 'q"\\']
		const problems = TARGETS.flatMap((target) =>
			texts.flatMap((text) => {
				const found = literalProblem(target, text)
				return found === null ? [] : [`${target} ${JSON.stringify(text)}: ${found}`]
			}),
		)
		expect(problems).toEqual([])
	})

	it("holds over the F2 fuzz, every target and comment form", () => {
		const fuzzed = [
			...TARGETS.flatMap((target, at) => failures(21 + at, (text) => literalProblem(target, text), 2_000)),
			...failures(29, commentProblem, 2_000),
		]
		expect(fuzzed).toEqual([])
	})
})

describe("gen adversarial: names in emitted source", () => {
	it("orders fields by code unit, the same whatever order the spec lists them in", () => {
		const names = ["b", "_", "B", "a", "Z"]
		const emit = (order: readonly string[]) =>
			typeOf({ properties: Object.fromEntries(order.map((n) => [n, { type: "string" }])), type: "object" })
		const outputs = [names, names.toReversed(), ["Z", "a", "B", "_", "b"]].map(emit)
		expect(new Set(outputs).size).toBe(1)
		expect(outputs[0]).toBe("{ B?: string; Z?: string; _?: string; a?: string; b?: string }")
	})
})

describe("gen adversarial: spec text never becomes source", () => {
	it("keeps property names and enum values that read as code as data", () => {
		const keys = ['"; process.exit(1); "', "*/", "a-b", "x y", "constructor", "${x}"]
		const values = ['"; process.exit(1) //', "*/ evil /*", "${x}", "`"]
		const object = compiled(
			typeOf({ properties: Object.fromEntries(keys.map((k) => [k, { type: "number" }])), type: "object" }),
		)
		const union = compiled(typeOf({ enum: values }))
		expect([object.errors, [...object.members].sort(), union.errors, [...union.values].sort()]).toEqual([
			[],
			[...keys].sort(),
			[],
			[...values].sort(),
		])
	})
})

/* a digest compared by value: an operator, an equality method or a byte-wise library compare */
const VALUE_COMPARE =
	/\b(?:expected|given)\b\s*(?:===?|!==?|\.equals\(|\.SequenceEqual\()|(?:===?|!==?)\s*\b(?:expected|given)\b|bytes\.Equal|Arrays\.equals|memcmp/

describe("emit adversarial: webhook signatures", () => {
	it.each(WEBHOOK_LANGUAGES)("%s's verify helper never compares the digest by value", (language) => {
		expect(VALUE_COMPARE.exec(verifyHelper(language))?.[0] ?? null).toBeNull()
	})
})
