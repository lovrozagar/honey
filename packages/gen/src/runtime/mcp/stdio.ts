/**
 * MCP's stdio transport (bit 18): each message one line of JSON on standard input, each reply one line on standard
 * output, nothing else ever written there; a line that is not JSON answered as a parse error. Each message is answered
 * as it comes, so calls run side by side and a reply goes out when its call is done, matched by its id; a protocol
 * fault answers at once, in the order it came. One writer writes each reply whole. The session ends when standard input
 * does, once every reply is written, or when `stop` aborts: every call in flight is aborted with it and settles, and
 * no reply after is written.
 */
import { ErrorCode, failure, isId, type Message } from "./jsonrpc.ts"
import type { Session } from "./server.ts"

/** Where the transport reads and writes: by default the process's standard input and output. */
export type Stdio = {
	readonly input: NodeJS.ReadableStream
	readonly write: (line: string) => void
}

/** The process's own standard input and output. */
const processStdio = (): Stdio => ({ input: process.stdin, write: (line) => void process.stdout.write(line) })

/** Serves `session` over `stdio` until its input ends or `stopped` aborts; settles once the last reply is written. */
export function serveStdio(session: Session, stdio: Stdio = processStdio(), stopped?: AbortSignal): Promise<void> {
	const stop = new AbortController()
	let pending = ""
	const inFlight = new Set<Promise<void>>()
	const send = (reply: unknown) => void (stop.signal.aborted || stdio.write(`${JSON.stringify(reply)}\n`))
	const take = (line: string) => {
		let message: Message
		try {
			message = JSON.parse(line) as Message
		} catch {
			/* through the queue the answers take, so a fault still answers in the order it came */
			return void Promise.resolve().then(() => send(failure(null, ErrorCode.ParseError, "Parse error")))
		}
		const answered: Promise<void> = session.answer(message, stop.signal, send).then(
			(reply) => void (reply === undefined || send(reply)),
			/* a fault inside a handler answers its request, and the session goes on */
			() => send(failure(isId(message.id) ? message.id : null, ErrorCode.InternalError, "Internal error")),
		)
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
