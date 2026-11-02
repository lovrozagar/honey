import type { ResumableConnection } from "./realtime.ts"
import { type RealtimeOptions, realtimeConnection } from "./realtime-transports.ts"
import type { RequestOptions } from "./request.ts"
import { type OperationCall, templateOf } from "./sdk.ts"

/** An x-realtime op: one resumable connection per call, dialed through the client. */
export const realtimeOp: OperationCall =
	(core, entry) =>
	(input: RequestOptions & RealtimeOptions = {}): ResumableConnection =>
		realtimeConnection(core.http, templateOf(entry), input)
