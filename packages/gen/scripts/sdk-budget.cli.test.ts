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
 * - phase b, +19,431 B to 21,993 B, nothing dead to cut (every member is reached by an emitted command or the global
 *   flags):
 *   - config.go 5,955: the global flags, each setting from its flag, its environment variable or the TOML config file
 *     (found by --config, $<PREFIX>_CONFIG, XDG or HOME, an unknown key refused), the readable-key warning;
 *   - params.go 5,168: the parameter flags, each checked against its kind and enum as given, the help naming the enum
 *     and a required flag; the path parameters, positional or flagged; Set, a flag's values into an Opts field's type;
 *   - body.go 3,869: --data (as given, @file, standard input), the JSON body with each body flag over its key, the
 *     text, form and streamed binary bodies;
 *   - run.go +1,626 to 4,188: the exit codes by outcome (4xx, 5xx, no answer, usage, redirect, interrupt), APIError,
 *     the App the root is named by, Ctrl-C cancelling the call;
 *   - log.go 2,197: --verbose, the request and response on stderr with every credential header and secret redacted;
 *   - output.go 616: an answer as one line of compact JSON (bytes and text as they came);
 *   provisional 22,000.
 * A change raises it only by the bytes of a named feature, dead code cut first.
 */
const CLI_RUNTIME_BYTES = 22000

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
