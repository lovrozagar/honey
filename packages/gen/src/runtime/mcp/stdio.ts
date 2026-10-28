/**
 * MCP's stdio transport (bit 18): each message one line of JSON on standard input, each reply one line on standard
 * output, nothing else ever written there; a line that is not JSON answered as a parse error. Each message is answered
 * as it comes: a fault at once, in the order it came, a call when it is done, matched by its id, so calls run side by
 * side. One writer writes each reply whole. Bit 21 b: the connection keeps its negotiated legacy revision; a
 * notifications/cancelled aborts the call it names, nothing more written for it. Bit 21 c: `read`, the file reader,
 * reaches every call. The session ends when standard input
 * does, once every reply is written, or when `stop` aborts: every call in flight is aborted with it and settles, and
 * no reply after is written.
 */
import { ErrorCode, failure, isId } from "./jsonrpc.ts"
import type { Connection, Context, Protocol } from "./protocol.ts"

/** Where the transport reads and writes: by default the process's standard input and output. */
export type Stdio = {
	readonly input: NodeJS.ReadableStream
	readonly write: (line: string) => void
}

/** The process's own standard input and output. */
const processStdio = (): Stdio => ({ input: process.stdin, write: (line) => void process.stdout.write(line) })

/** Serves `protocol` over `stdio` until its input ends or `stopped` aborts; settles once the last reply is written. */
export function serveStdio(
	protocol: Protocol,
	stdio: Stdio = processStdio(),
	stopped?: AbortSignal,
	read?: Context["read"],
): Promise<void> {
	const stop = new AbortController()
	const connection: Connection = {}
	/* each call in flight by its id: its own abort */
	const calls = new Map<unknown, AbortController>()
	let pending = ""
	const inFlight = new Set<Promise<void>>()
	const writer = (signal: AbortSignal) => (reply: unknown) =>
		void (signal.aborted || stdio.write(`${JSON.stringify(reply)}\n`))
	const take = (line: string) => {
		let message: { id?: unknown; method?: unknown; params?: { requestId?: unknown } } | null
		try {
			message = JSON.parse(line) as typeof message
		} catch {
			return writer(stop.signal)(failure(null, ErrorCode.ParseError, "Parse error"))
		}
		if (message?.method === "notifications/cancelled") return void calls.get(message.params?.requestId)?.abort()
		const call = new AbortController()
		const signal = AbortSignal.any([stop.signal, call.signal])
		const send = writer(signal)
		const id = message?.id
		const done = (reply: unknown) =>
			void (calls.get(id) === call && calls.delete(id), reply === undefined || send(reply))
		const answer = protocol.answer(message, { connection, notify: send, read, signal })
		if (!(answer instanceof Promise)) return done(answer)
		if (isId(id)) calls.set(id, call)
		const answered: Promise<void> = answer.then(done)
		inFlight.add(answered)
		void answered.then(() => inFlight.delete(answered))
	}
	return new Promise((settle) => {
		stopped?.addEventListener("abort", () => {
			stop.abort()
			void Promise.all(inFlight).then(() => settle())
		})
		stdio.input.setEncoding("utf8")
		stdio.input.on("data", (chunk: string) => {
			pending += chunk
			for (let end = pending.indexOf("\n"); end >= 0; end = pending.indexOf("\n")) {
				const line = pending.slice(0, end).trim()
				pending = pending.slice(end + 1)
				if (line !== "") take(line)
			}
		})
		stdio.input.on("end", () => {
			if (pending.trim() !== "") take(pending.trim())
			void Promise.all(inFlight).then(() => settle())
		})
	})
}
