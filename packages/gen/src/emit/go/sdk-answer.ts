/**
 * How a Go method answers (G1, F1): a JSON body decoded into `*T`, a binary one as `[]byte`, a text
 * one as `string`, in safe mode each inside `SDKResult`; a WebSocket operation its dialed socket;
 * an operation without a body `error` alone.
 */
import type { SdkResponseKind } from "../../ir/sdk-model.ts"

/** How a method answers: its return types, the values it fails with, and the statements that send `c`. */
export type Shape = { readonly returns: string; readonly fail: string; readonly tail: (send: string) => string[] }

/* a WebSocket operation: the dialed socket */
const WS_SHAPE: Shape = {
	fail: "nil, err",
	returns: "(*TypedWebSocket, error)",
	tail: (send) => [`\treturn dialWebSocket(${send})`],
}

/* an operation answering without a body, in either error mode */
const NO_BODY_SHAPE: Shape = {
	fail: "err",
	returns: "error",
	tail: (send) => [`\tif _, err := doRequest(${send}); err != nil {`, "\t\treturn err", "\t}", "\treturn nil"],
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
	const tail = (send: string) => [
		`\tresult, err := doRequest(${send})`,
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
	const tail = (send: string) => [
		`\tresult, err := doRequest(${send})`,
		"\tif err != nil {",
		`\t\treturn safeResult[${answer.type}](nil, nil, err)`,
		"\t}",
		...settle,
	]
	return { fail: `${result}{}, err`, returns: `(${result}, error)`, tail }
}

/** What the method of an operation answers: `kind` of `result` (its JSON type), streaming `ws` or not. */
export type Answered = {
	readonly kind: SdkResponseKind
	readonly result: string | undefined
	readonly ws: boolean
	readonly throwOnError: boolean
}

/** The shape of a method answering as `answered`; a JSON answer without a schema has none to decode. */
export function shapeOf(answered: Answered): Shape {
	if (answered.ws) return WS_SHAPE
	const { kind, result } = answered
	if (kind !== "binary" && kind !== "text" && result === undefined) return NO_BODY_SHAPE
	const answer = answerOf(kind, result as string)
	return answered.throwOnError ? throwShape(answer) : safeShape(answer)
}
