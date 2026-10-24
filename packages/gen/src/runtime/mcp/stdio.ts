/**
 * MCP's stdio transport (bit 18): each message one line of JSON on standard input, each reply one line on standard
 * output, nothing else ever written there; a line that is not JSON answered as a parse error. Replies go out in the
 * order the requests came. The session ends when standard input does, once every reply is written.
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

/** Serves `session` over `stdio` until its input ends; settles once the last reply is written. */
export function serveStdio(session: Session, stdio: Stdio = processStdio()): Promise<void> {
	const stop = new AbortController()
	let pending = ""
	let queue = Promise.resolve()
	const send = (reply: unknown) => stdio.write(`${JSON.stringify(reply)}\n`)
	const take = (line: string) => {
		let message: Message
		try {
			message = JSON.parse(line) as Message
		} catch {
			queue = queue.then(() => send(failure(null, ErrorCode.ParseError, "Parse error")))
			return
		}
		queue = queue.then(async () => {
			try {
				const reply = await session.answer(message, stop.signal)
				if (reply !== undefined) send(reply)
			} catch {
				/* a fault inside a handler answers its request, and the session goes on */
				send(failure(isId(message.id) ? message.id : null, ErrorCode.InternalError, "Internal error"))
			}
		})
	}
	return new Promise((settle) => {
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
			void queue.then(() => settle())
		})
	})
}
