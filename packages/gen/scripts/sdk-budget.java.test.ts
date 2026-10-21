/**
 * The Java SDK's budgets (bit 16): the vendored runtime's bytes on disk (the G14 analog), measured, every file named,
 * split from `sdk-budget.test.ts` at its 500-line cap. Phase f adds the per-operation token ceiling (the G13 analog).
 */
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"
import { runtimeFiles } from "../src/emit/java/sdk.ts"
import { runtimeBytes } from "./sdk-budget.ts"

/*
 * G14 analog, phase a (bit 16): the measured 450 B, provisional until phase f locks it, of Transport.java 450 — the
 * one HttpClient, built once on followRedirects(NEVER), and its base URL. Each later phase raises it only by the
 * bytes of a named feature, dead code cut first.
 */
const JAVA_RUNTIME_BYTES = 450

describe("the Java runtime within its byte budget (bit 16, the G14 analog)", () => {
	it(`ships every runtime file it holds, all of them within ${JAVA_RUNTIME_BYTES} bytes, nothing else beside them`, () => {
		const { bytes, names, others } = runtimeBytes(resolve(import.meta.dirname, "../src/runtime/java"), ".java")
		expect({ names, others, over: Math.max(0, bytes - JAVA_RUNTIME_BYTES) }).toEqual({
			names: Object.keys(runtimeFiles("x")).map((name) => `${name}.java`),
			others: [],
			over: 0,
		})
	})
})
