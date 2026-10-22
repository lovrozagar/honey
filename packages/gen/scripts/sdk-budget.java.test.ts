/**
 * The Java SDK's budgets (bit 16): the vendored runtime's bytes on disk (the G14 analog), measured, every file named,
 * split from `sdk-budget.test.ts` at its 500-line cap. Phase f adds the per-operation token ceiling (the G13 analog).
 */
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"
import { runtimeFiles } from "../src/emit/java/sdk.ts"
import { runtimeBytes } from "./sdk-budget.ts"

/*
 * G14 analog (bit 16), provisional until phase f locks it, measured over every runtime file:
 * - phase a, 450 B: Transport.java 450, the one HttpClient, built once on followRedirects(NEVER), and its base URL;
 * - phase b, +3,816 B to 4,266 B: Opt.java 3,106, the three-state optional (absent, null, value) with its reader and
 *   writer, equals/hashCode/toString for the records that hold one; Json.java 710, the one mapper, unknown properties
 *   ignored and the Opt module registered. Nothing dead to cut: each member is reached by a model or a record.
 * - phase c1, +47,695 B to 51,961 B, after a 1,345 B cut (one percent-encoder, one hook loop, one parse of an error
 *   body, the duplicated helpers and the docs that restated their records):
 *   - the request, 10,199 B: Operation 395 and Call 589, an operation's description and one call's values; Body
 *     3,832, BinaryBody 943 and FilePart 214, the JSON, form, text, binary and multipart bodies; UrlPath 1,550 and
 *     UrlQuery 2,676, the path segments and the query, percent-encoded through one encoder;
 *   - the exchange, 16,756 B: Exchange 920, a client's one HTTP client and credential; Flight 8,510, one call's hops,
 *     its auth retry and its one deadline; ClientConfig 5,206 and RequestOptions 2,120, the client's config and one
 *     call's overrides;
 *   - the answer, 3,429 B: Answer 1,604, read as the call's type or as a Result; RawResponse 1,176, the raw box;
 *     Result 649, safe mode's Ok and Err;
 *   - the errors, 9,435 B: HoneyException 391, the base; ApiException 3,634, the status error with its key, detail,
 *     envelope and decodeBody; Envelope 4,691, the envelope's reader and the detail's sanitizer (R3); ErrorEnvelope
 *     719, its members;
 *   - auth, 1,442 B: Credential, the token and its single-flight refresh;
 *   - hooks and the log, 6,434 B: Hooks 1,338, RequestContext 1,506, ResponseContext 1,191, RequestHook 314 and
 *     ResponseHook 338, the hooks and what they may change; CallLog 1,382 and LogEntry 365, the log lines.
 * Each later phase raises it only by the bytes of a named feature, dead code cut first.
 */
const JAVA_RUNTIME_BYTES = 51961

describe("the Java runtime within its byte budget (bit 16, the G14 analog)", () => {
	it(`ships every runtime file it holds, all of them within ${JAVA_RUNTIME_BYTES} bytes, nothing else beside them`, () => {
		const { bytes, names, others } = runtimeBytes(resolve(import.meta.dirname, "../src/runtime/java"), ".java")
		expect({ names, others, over: Math.max(0, bytes - JAVA_RUNTIME_BYTES) }).toEqual({
			names: Object.keys(runtimeFiles("x"))
				.map((name) => `${name}.java`)
				.sort(),
			others: [],
			over: 0,
		})
	})
})
