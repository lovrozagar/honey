/**
 * The generated CLI's budgets (bit 17): the vendored CLI runtime's bytes on disk (the G14 analog), measured, every
 * file named. Its per-operation token ceiling joins at phase i, measured from the built binary.
 */
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"
import { CLI_RUNTIME } from "../src/emit/cli/module.ts"
import { runtimeBytes } from "./sdk-budget.ts"

/*
 * G14 analog (bit 17), provisional until the close locks it at the exact measured bytes:
 * - phase a, 2,562 B: run.go, the root command's shape (--version alone, no default completion, an unknown command
 *   or flag a usage error), the run that maps an outcome to its exit code, and the version a release links in;
 *   provisional 2,600.
 * A change raises it only by the bytes of a named feature, dead code cut first.
 */
const CLI_RUNTIME_BYTES = 2600

describe("the CLI runtime within its byte budget (bit 17, the G14 analog)", () => {
	it(`ships every runtime file it holds, all of them within ${CLI_RUNTIME_BYTES} bytes, nothing else beside them`, () => {
		const { bytes, names, others } = runtimeBytes(resolve(import.meta.dirname, "../src/runtime/cli"), ".go")
		expect({ names, others, over: Math.max(0, bytes - CLI_RUNTIME_BYTES) }).toEqual({
			names: [...CLI_RUNTIME].sort(),
			others: [],
			over: 0,
		})
	})
})
