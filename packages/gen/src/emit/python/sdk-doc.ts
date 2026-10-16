/**
 * A method's docstring: the operation's summary, a blank line, its description, then in throw mode a
 * `Raises:` line per declared error status, ascending, naming the class the runtime raises for it. Spec text
 * goes through `pyDocLines`, so a quote or backslash in it stays inert. No docstring without any of the three.
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

/** The docstring of `op`'s method at 8 spaces, or none. */
export function methodDoc(op: SdkOp, throwOnError: boolean): string[] {
	const raises = throwOnError
		? op.errorStatuses.map((s) => `    ${STATUS_ERRORS[s] ?? "APIStatusError"}: HTTP ${s}`)
		: []
	const parts = [
		op.summary.trim(),
		op.description.trim(),
		...(raises.length > 0 ? [["Raises:", ...raises].join("\n")] : []),
	]
	const lines = pyDocLines(parts.filter((part) => part !== "").join("\n\n"))
	if (lines.length === 1 && lines[0] === "") return []
	/* a docstring that opens on its Raises: block opens on a line of its own, so the block keeps its shape */
	const open = lines[0] === "Raises:" ? ['"""', ...lines] : [`"""${lines[0]}`, ...lines.slice(1)]
	const body = lines.length === 1 ? [`"""${lines[0]}"""`] : [...open, '"""']
	return body.map((line) => (line === "" ? "" : `        ${line}`))
}
