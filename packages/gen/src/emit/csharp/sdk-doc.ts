/**
 * XML doc comments (Fb4): a method's summary and its description as remarks, then in throw mode an `<exception>`
 * per declared error status, ascending, naming the class the runtime throws for it (`UnexpectedStatusException`
 * for one without a class of its own, Fb14). Spec text goes through `csDocLines`, so XML's specials are entities
 * and a line break of any kind starts a new `///` line (Q7). No `<param>` tag: a partial set is CS1573.
 */
import type { SdkOp } from "../../ir/sdk-model.ts"
import { csDocLines } from "../shared/escape.ts"

/* the runtime's status classes (runtime/csharp/Errors.cs, Python's statuses); any other status throws UnexpectedStatusException */
const STATUS_EXCEPTIONS: Readonly<Record<number, string>> = {
	400: "BadRequestException",
	401: "UnauthorizedException",
	403: "ForbiddenException",
	404: "NotFoundException",
	409: "ConflictException",
	422: "UnprocessableEntityException",
	429: "RateLimitException",
	500: "InternalServerException",
	502: "BadGatewayException",
	503: "ServiceUnavailableException",
	504: "GatewayTimeoutException",
}

/** `text` as `/// <tag>…</tag>` lines at `indent`; none for blank text. */
export function docLines(tag: string, text: string | undefined, indent = ""): string[] {
	const trimmed = (text ?? "").trim()
	if (trimmed === "") return []
	const lines = csDocLines(trimmed)
	lines[0] = `<${tag}>${lines[0]}`
	lines[lines.length - 1] = `${lines.at(-1)}</${tag}>`
	return lines.map((line) => `${indent}/// ${line}`.trimEnd())
}

/** The doc lines of `op`'s method at 4 spaces: its summary, its remarks, and in throw mode its exceptions. */
export function methodDoc(op: SdkOp, throwOnError: boolean): string[] {
	const raises = throwOnError ? op.errorStatuses : []
	return [
		...docLines("summary", op.summary, "    "),
		...docLines("remarks", op.description, "    "),
		...raises.map(
			(status) =>
				`    /// <exception cref="${STATUS_EXCEPTIONS[status] ?? "UnexpectedStatusException"}">HTTP ${status}</exception>`,
		),
	]
}
