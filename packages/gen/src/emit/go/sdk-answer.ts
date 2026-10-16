/**
 * How a Go method answers (G1, F1): a JSON body decoded into `*T`, a binary one as `[]byte`, a text
 * one as `string`, in safe mode each inside `SDKResult`; an operation without a body `error` alone.
 * A streaming operation answers as its `GoStream` says (`sse.ts`, `ws.ts`), in either error mode.
 */
import type { SdkResponseKind } from "../../ir/sdk-model.ts"
import type { StreamOpts } from "./sdk-opts.ts"

/** How a method answers: its return types, the values it fails with, and the statements that send `c` from the `*Client` at `client`. */
export type Shape = { readonly returns: string; readonly fail: string; readonly tail: (client: string) => string[] }

/** What a streaming operation's method is: how it answers, what its Opts add, and the note its godoc ends on. */
export type GoStream = { readonly shape: Shape; readonly opts: StreamOpts; readonly doc: string }

/** The runtime call's arguments: the ctx, the client's config, the call, each of `extra`, then the per-call options. */
export const sendArgs = (client: string, ...extra: string[]) =>
	["ctx", `${client}.cfg`, "c", ...extra, "reqOpts"].join(", ")

/* an operation answering without a body, in either error mode */
const NO_BODY_SHAPE: Shape = {
	fail: "err",
	returns: "error",
	tail: (client) => [
		`\tif _, err := doRequest(${sendArgs(client)}); err != nil {`,
		"\t\treturn err",
		"\t}",
		"\treturn nil",
	],
}

/** An answer's Go type, its zero value, and the expression reading it from `result` (as data and the decode error). */
type Answer = { readonly type: string; readonly zero: string; readonly read: string; readonly pointer: boolean }

/** The answer of each body kind: JSON decoded into `*T`, binary as the bytes, text as the string. */
function answerOf(kind: SdkResponseKind, result: string): Answer {
	if (kind === "binary") return { pointer: false, read: "result.body", type: "[]byte", zero: "nil" }
	if (kind === "text") return { pointer: false, read: "string(result.body)", type: "string", zero: '""' }
	return { pointer: true, read: `decodeJSON[${result}](result.body)`, type: result, zero: "nil" }
}

/** A throw-mode method: the answer, an error status as the error. */
function throwShape(answer: Answer): Shape {
	const fail = `${answer.zero}, err`
	const done = answer.pointer ? `\treturn ${answer.read}` : `\treturn ${answer.read}, nil`
	const tail = (client: string) => [
		`\tresult, err := doRequest(${sendArgs(client)})`,
		"\tif err != nil {",
		`\t\treturn ${fail}`,
		"\t}",
		done,
	]
	return { fail, returns: `(${answer.pointer ? "*" : ""}${answer.type}, error)`, tail }
}

/** A safe-mode method: `SDKResult[T]`, an error status in its Err, every other failure the error (F5). */
function safeShape(answer: Answer): Shape {
	const result = `SDKResult[${answer.type}]`
	const settle = answer.pointer
		? [`\tdata, err := ${answer.read}`, "\treturn safeResult(data, result, err)"]
		: [`\tdata := ${answer.read}`, "\treturn safeResult(&data, result, nil)"]
	const tail = (client: string) => [
		`\tresult, err := doRequest(${sendArgs(client)})`,
		"\tif err != nil {",
		`\t\treturn safeResult[${answer.type}](nil, nil, err)`,
		"\t}",
		...settle,
	]
	return { fail: `${result}{}, err`, returns: `(${result}, error)`, tail }
}

/** What the method of an operation that answers once answers: `kind` of `result` (its JSON type). */
export type Answered = {
	readonly kind: SdkResponseKind
	readonly result: string | undefined
	readonly throwOnError: boolean
}

/** The shape of a method answering as `answered`; a JSON answer without a schema has none to decode. */
export function shapeOf(answered: Answered): Shape {
	const { kind, result } = answered
	if (kind !== "binary" && kind !== "text" && result === undefined) return NO_BODY_SHAPE
	const answer = answerOf(kind, result as string)
	return answered.throwOnError ? throwShape(answer) : safeShape(answer)
}
