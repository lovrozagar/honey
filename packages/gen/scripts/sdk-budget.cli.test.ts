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
 * - phase c, +13,970 B to 35,963 B, after cutting a second error classification and a duplicated render path (214 B):
 *   - output.go +6,158 to 6,774: --format json/ndjson/yaml/table, --json, table the default on a terminal, -i (status
 *     and the declared headers), --raw, -o, a binary answer refused on a terminal or under -i, compact JSON with DEL
 *     and C1 escaped, control characters escaped on a terminal;
 *   - format.go 4,604: the YAML writer (keys and scalars quoted where a reader would misread them) and the table
 *     (a column per key over a list of objects, a key and value per row for an object, nested values as JSON);
 *   - run.go +1,361 to 5,549: an error on stderr as one JSON line by kind, status and key, else after the name with
 *     its controls escaped; one classification feeding both the kind and the exit code;
 *   - body.go +962 to 4,831: the multipart file parts, a file or standard input per part, repeatable;
 *   - log.go +885 to 3,082: each secret also as the SDK percent-encodes it into a path and a query;
 *   provisional 36,000.
 * - phase d, +7,690 B to 43,653 B, after cutting Closed's Unwrap (kindOf takes any close as transport):
 *   - stream.go 5,802: a stream's output (one line per event, a YAML document each, ndjson for a table, -o, --take,
 *     -i and --raw refused), the SSE event line, a message's bytes as JSON, a string or base64, the realtime feed
 *     followed to its end with its cursor on stderr, --max-reconnects, Closed (an abnormal close, a transport failure);
 *   - socket.go 1,738, shipped only beside the WebSocket library: stdin lines as text frames, each message printed, a
 *     close frame on --take and on Ctrl-C, the close code as the outcome;
 *   - run.go +150 to 5,699: Ctrl-C ending a stream with no error still exits 130; Closed classed as transport;
 *   provisional 43,700.
 * - phase e, +10,024 B to 53,677 B, after reusing sortedKeys for config's headers and cutting a second redaction of
 *   credential headers (redact already holds their values), 156 B:
 *   - discovery.go 4,339: `commands` (the local line, a usage line per command, --json one object each), `commands
 *     search` (shared words, ties in path order, 5 at most), `schema` and its JSON, `skill`;
 *   - target.go 3,292: the target (loopback local, else remote, by host), the terminal-only target line under -q,
 *     `config` (each setting with its source, secrets redacted, as text or one JSON object);
 *   - config.go +1,321 to 7,276: each setting's source, --quiet ($<PREFIX>_QUIET, the file's quiet), the API's server;
 *   - run.go +919 to 6,618: the App's server, discovery and skill; the API and local help groups, the two-line banner;
 *   - params.go +153 to 5,321: an enum flag's values completing;
 *   provisional 53,700.
 * - phase f, +1,642 B to 55,319 B, nothing dead to cut (each line serves the redirect setting or its hint):
 *   - config.go +994 to 8,270: --redirect same-origin|follow ($<PREFIX>_REDIRECT, the file's redirect), an unknown
 *     value a usage error, and the setting read again where an error is reported;
 *   - run.go +624 to 7,242: a redirect not followed names the way out (rerun with --redirect follow);
 *   - target.go +24 to 3,316: `config` shows the redirect policy with its source;
 *   provisional 55,400.
 * A change raises it only by the bytes of a named feature, dead code cut first.
 */
const CLI_RUNTIME_BYTES = 55400

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
