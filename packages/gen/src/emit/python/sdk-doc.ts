/**
 * A method's docstring: the operation's summary, a blank line, its description, a stream's own lines (how it
 * opens and ends), then a `Raises:` line per declared error status, ascending, naming the class the
 * runtime raises for it. Spec text goes through `pyDocLines`, so a quote or backslash in it stays inert; a
 * stream's lines are the emitter's own, as they are. No docstring without any of the four.
 */
import type { SdkOp } from "../../ir/sdk-model.ts"
import { pyDocLines } from "../shared/escape.ts"

/* the runtime's STATUS_ERRORS (runtime/python/errors.py); any other status raises APIStatusError */
const STATUS_ERRORS: Readonly<Record<number, string>> = {
	400: "BadRequestError",
	401: "UnauthorizedError",
	403: "ForbiddenError",
	404: "NotFoundError",
	409: "ConflictError",
	422: "UnprocessableEntityError",
	429: "RateLimitError",
	500: "InternalServerError",
	502: "BadGatewayError",
	503: "ServiceUnavailableError",
	504: "GatewayTimeoutError",
}

/** The docstring of `op`'s method at 8 spaces, `stream` its stream's own lines, or none. */
export function methodDoc(op: SdkOp, stream: readonly string[]): string[] {
	const raises = op.errorStatuses.map((s) => `    ${STATUS_ERRORS[s] ?? "APIStatusError"}: HTTP ${s}`)
	const spec = [op.summary.trim(), op.description.trim()].filter((part) => part !== "")
	const parts = [
		...spec.map(pyDocLines),
		...(stream.length > 0 ? [[...stream]] : []),
		...(raises.length > 0 ? [["Raises:", ...raises]] : []),
	]
	const lines = parts.flatMap((part, i) => (i === 0 ? part : ["", ...part]))
	if (lines.length === 0) return []
	/* a docstring that opens on its Raises: block opens on a line of its own, so the block keeps its shape */
	const open = lines[0] === "Raises:" ? ['"""', ...lines] : [`"""${lines[0]}`, ...lines.slice(1)]
	const body = lines.length === 1 ? [`"""${lines[0]}"""`] : [...open, '"""']
	return body.map((line) => (line === "" ? "" : `        ${line}`))
}
