/**
 * The generated TS SDK as a consumer types it (bit 21 i1), checked by this app's `type:check` (typecheck:consumers),
 * never run. The normal client answers the value and throws an error status, so the safe pattern it replaced, kept
 * unchanged, no longer compiles (each `@ts-expect-error` reds the check the day it does); `client.safe` answers a
 * Result whose arms narrow on `ok`, and a wrong-arm read does not compile.
 */
import {
	Api,
	type ClientError,
	type CreateProjectsExtractResponse200,
	DecodeError,
	type Result,
	type SSEEvent,
} from "../../src/_gen/mcp/api.index.gen"

const client = new Api({ baseURL: "http://localhost" })
const input = { form: { text: "x" }, params: { project_id: "p" } }

export async function normalClient(): Promise<CreateProjectsExtractResponse200> {
	return client.suggest.schema(input)
}

export async function oldSafePattern(): Promise<unknown> {
	// @ts-expect-error -- bit 21 i1: the normal client answers the value; `{ data, error }` is the safe call's no more
	const { data, error } = await client.suggest.schema(input)
	if (error) return error
	return data
}

export async function safeClient(): Promise<string> {
	const result: Result<CreateProjectsExtractResponse200> = await client.safe.suggest.schema(input)
	// @ts-expect-error -- a wrong-arm read: `data` is the Ok arm's alone
	void result.data
	if (result.ok) return `${result.data.status} ${result.response.status}`
	const error: ClientError | DecodeError = result.error
	if (error instanceof DecodeError) return `${error.body ?? "past the cap"} ${result.response.status}`
	return `${error.status} ${result.response.status}`
}

export async function safeStream(): Promise<SSEEvent[]> {
	const opened = await client.safe.extract.stream(input)
	if (!opened.ok) return []
	const events: SSEEvent[] = []
	for await (const event of opened.data) events.push(event)
	return events
}

export async function safeRaw(): Promise<Response | ClientError> {
	const raw = await client.safe.suggest.schema({ ...input, raw: true })
	return raw.ok ? raw.data : raw.error
}
