/**
 * Whether a program let a stream's connection go while it still ran, decided by an ordering signal and not a
 * clock. The program's next request marks the release point: the recording server holds its reply until the
 * stream's client left (recording-server.ts `afterLeft`, at most `withinMs`), and notes which came first. The
 * program waits on that reply, so it runs until the server saw the close or the bound passed. A connection let go
 * only as the program ends (a leak a runtime's teardown or the kernel closes at exit) cannot close in time, and is
 * no release. A release costs no pause: the reply goes out once the close is seen.
 */
import type { Reply } from "./recording-server.ts"

/** How long the next reply waits for the close before it goes out with the release unseen. */
export const GONE_WITHIN_MS = 5_000

/** A release check: the next request's reply, and the verdict once the program ran. */
export type Gone = {
	/** true when the server saw the client leave before it answered `reply`; false when the bound came first or `reply` was never asked for */
	released(): boolean
	readonly reply: Reply
}

type Options = { readonly stream?: number; readonly withinMs?: number }

/** `then` as the reply to the program's next request, held until hop `stream` (0)'s client left: the check. */
export function gone(then: Reply, options: Options = {}): Gone {
	const verdict = { left: false }
	const afterLeft = {
		seen: (left: boolean) => void (verdict.left = left),
		stream: options.stream ?? 0,
		withinMs: options.withinMs ?? GONE_WITHIN_MS,
	}
	return { released: () => verdict.left, reply: { ...then, afterLeft } }
}
