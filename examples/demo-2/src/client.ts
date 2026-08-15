import { createClient, isClientError, parseSSEStream } from "honey/client"
import type { app } from "./app"

/* ================================================================
   CLIENT SETUP — all config options
   ================================================================ */

const api = createClient<typeof app>({
	baseURL: "http://localhost:3000",

	/* async headers — called every request, receives method + path */
	headers: async ({ method, path }) => {
		if (path.startsWith("/in/none")) return {}
		return { authorization: `Bearer ${await Promise.resolve("my-token")}` }
	},

	/* interceptors */
	onRequest: [
		(ctx) => {
			ctx.headers.set("x-correlation-id", crypto.randomUUID())
		},
	],
	onResponse: [
		async (ctx) => {
			/* auto-retry on 401 */
			if (ctx.response.status === 401 && !ctx.isRetry) {
				return ctx.retry()
			}
		},
	],

	/* search params */
	sortSearchParams: true,
})

async function main() {
	/* ================================================================
	   TUPLE MODE (default) — { data, error, response, status }
	   ================================================================ */

	/* success → data is typed, error is null */
	const { data, error } = await api.get("/in/none")
	if (error) {
		console.log(error.errorKey, error.status)
		return
	}
	console.log(data.ping)
	/*               ^ "pong" — narrowed after error check */

	/* error → data is null, error is ClientError */
	const result = await api.get("/in/headers", {
		headers: { "x-api-key": "", "x-request-id": "" },
	})
	if (result.error) {
		console.log(result.error.errorKey, result.error.fields)
		console.log(result.status)
		/*                 ^ number */

		/* response body still readable */
		const raw = await result.response.json()
		console.log(raw)
	}

	/* 204 → data is null, error is null */
	const deleted = await api.delete("/out/no-content/:id", { params: { id: "42" } })
	console.log(deleted.data)
	/*                  ^ null */
	console.log(deleted.status)
	/*                  ^ 204 */

	/* ================================================================
	   $isClientError — on the client instance
	   ================================================================ */

	const maybe = await api.get("/in/none")
	if (api.$isClientError(maybe.error)) {
		console.log(maybe.error.errorKey)
	}

	/* standalone import works too */
	if (isClientError(maybe.error)) {
		console.log(maybe.error.status)
	}

	/* ================================================================
	   $url() / $path() — type-safe URL generation, no fetch
	   ================================================================ */

	const fullUrl = api.$url("/in/params/:orgId/members/:memberId", {
		params: { memberId: "m-1", orgId: "org-1" },
		search: { tab: "activity" },
	})
	console.log(fullUrl)
	/* → "http://localhost:3000/in/params/org-1/members/m-1?tab=activity" */

	const pathOnly = api.$path("/in/params/:orgId/members/:memberId", {
		params: { memberId: "m-1", orgId: "org-1" },
	})
	console.log(pathOnly)
	/* → "/in/params/org-1/members/m-1" */

	/* ================================================================
	   INPUT: every source solo
	   ================================================================ */

	/* json body */
	const fromJson = await api.post("/in/json", {
		json: { email: "a@b.com", name: "Alice" },
	})
	if (!fromJson.error) console.log(fromJson.data.id)

	/* form body */
	const fromForm = await api.post("/in/form", {
		form: { password: "s3cret", username: "alice" },
	})
	if (!fromForm.error) console.log(fromForm.data.token)

	/* search params */
	const fromSearch = await api.get("/in/search", {
		search: { limit: 10, page: 1, q: "test" },
	})
	if (!fromSearch.error) console.log(fromSearch.data.results)

	/* headers input */
	const fromHeaders = await api.get("/in/headers", {
		headers: { "x-api-key": "key-123", "x-request-id": "req-456" },
	})
	if (!fromHeaders.error) console.log(fromHeaders.data.accepted)

	/* cookies input */
	const fromCookies = await api.get("/in/cookies", {
		cookies: { locale: "en", sid: "sess-789" },
	})
	if (!fromCookies.error) console.log(fromCookies.data.locale, fromCookies.data.valid)

	/* path params — multi segment */
	const fromParams = await api.get("/in/params/:orgId/members/:memberId", {
		params: { memberId: "m-2", orgId: "org-1" },
	})
	if (!fromParams.error) console.log(fromParams.data.orgId, fromParams.data.memberId)

	/* no input */
	const fromNone = await api.get("/in/none")
	if (!fromNone.error) console.log(fromNone.data.ping)

	/* ================================================================
	   INPUT: combos
	   ================================================================ */

	/* json + search */
	const jsonSearch = await api.post("/in/json-search", {
		json: { name: "Test" },
		search: { dryRun: true },
	})
	if (!jsonSearch.error) console.log(jsonSearch.data.id, jsonSearch.data.dryRun)

	/* json + headers */
	const jsonHeaders = await api.post("/in/json-headers", {
		headers: { "x-idempotency-key": "idem-001" },
		json: { amount: 99.99 },
	})
	if (!jsonHeaders.error) console.log(jsonHeaders.data.paymentId)

	/* json + cookies */
	const jsonCookies = await api.post("/in/json-cookies", {
		cookies: { csrf: "tok-abc" },
		json: { message: "hello" },
	})
	if (!jsonCookies.error) console.log(jsonCookies.data.id)

	/* form + headers + cookies */
	const formHeadersCookies = await api.post("/in/form-headers-cookies", {
		cookies: { device: "mobile" },
		form: { code: "123456" },
		headers: { "x-fingerprint": "fp-xyz" },
	})
	if (!formHeadersCookies.error) console.log(formHeadersCookies.data.verified)

	/* search + cookies + headers */
	const searchCookiesHeaders = await api.get("/in/search-cookies-headers", {
		cookies: { timezone: "UTC" },
		headers: { "accept-language": "en-US" },
		search: { date: "2026-03-15" },
	})
	if (!searchCookiesHeaders.error) console.log(searchCookiesHeaders.data.events)

	/* json + search + headers + params — full monty */
	const allInputs = await api.put("/in/all/:resourceId", {
		headers: { "if-match": 'W/"v1"' },
		json: { data: { key: "value" } },
		params: { resourceId: "res-42" },
		search: { force: true, version: 1 },
	})
	if (!allInputs.error) console.log(allInputs.data.etag, allInputs.data.version)

	/* ================================================================
	   OUTPUT: every content-type
	   ================================================================ */

	/* application/json — typed object */
	const jsonOut = await api.get("/in/none")
	if (!jsonOut.error) console.log(jsonOut.data.ping)

	/* text/plain → string */
	const textOut = await api.get("/out/text")
	if (!textOut.error) console.log(textOut.data.toUpperCase())

	/* text/html → string */
	const htmlOut = await api.get("/out/html")
	if (!htmlOut.error) console.log(htmlOut.data.length)

	/* text/csv → string */
	const csvOut = await api.get("/out/csv")
	if (!csvOut.error) console.log(csvOut.data.split("\n"))

	/* application/xml → string */
	const xmlOut = await api.get("/out/xml")
	if (!xmlOut.error) console.log(xmlOut.data.includes("<root"))

	/* application/octet-stream → ArrayBuffer */
	const binaryOut = await api.get("/out/binary")
	if (!binaryOut.error) console.log(binaryOut.data.byteLength)

	/* text/event-stream — SSE via for-await */
	const sseOut = api.get("/out/sse")
	for await (const evt of sseOut) {
		console.log(evt.event, evt.data, evt.id, evt.retry)
	}

	/* ================================================================
	   OUTPUT: multi-status unions
	   ================================================================ */

	/* created | conflict */
	const multi = await api.post("/out/multi-status", { json: { slug: "acme" } })
	if (!multi.error) console.log(multi.data)
	/* ^ { id: string; slug: string } | { existing: string; message: string } */

	/* ok | accepted */
	const okOrAccepted = await api.post("/out/ok-or-accepted", { json: { payload: "x" } })
	if (!okOrAccepted.error) console.log(okOrAccepted.data)
	/* ^ { result: string } | { eta: number; jobId: string } */

	/* ================================================================
	   METHODS: all with tuple
	   ================================================================ */

	const g = await api.get("/methods/resource")
	if (!g.error) console.log(g.data.items)

	const po = await api.post("/methods/resource", { json: { name: "New" } })
	if (!po.error) console.log(po.data.id)

	const pu = await api.put("/methods/resource/:id", { json: { name: "Up" }, params: { id: "1" } })
	if (!pu.error) console.log(pu.data.id, pu.data.name)

	const pa = await api.patch("/methods/resource/:id", { json: { name: "Pa" }, params: { id: "1" } })
	if (!pa.error) console.log(pa.data.id)

	const de = await api.delete("/methods/resource/:id", { params: { id: "1" } })
	console.log(de.data)
	/*          ^ null */

	/* ================================================================
	   SSE: streaming with input
	   ================================================================ */

	const filteredStream = api.get("/stream/filtered", {
		search: { channel: "notifications", since: "2026-01-01" },
	})
	for await (const event of filteredStream) {
		console.log(event.data)
	}

	/* raw parseSSEStream */
	const rawRes = await fetch("http://localhost:3000/stream/events")
	if (rawRes.body) {
		for await (const event of parseSSEStream(rawRes.body)) {
			console.log(event.event, event.data)
		}
	}

	/* ================================================================
	   readableStream() — transparent to client
	   ================================================================ */

	const uploaded = await api.post("/rs/upload", {
		json: { chunks: 10, fileName: "data.csv" },
	})
	if (!uploaded.error) console.log(uploaded.data.uploadId)

	const ingested = await api.post("/rs/ingest", {
		headers: { "x-pipeline-id": "pipe-42" },
		json: { records: 50000 },
		search: { batch: true },
	})
	if (!ingested.error) console.log(ingested.data.pipelineId, ingested.data.eta)

	/* ================================================================
	   FILE UPLOAD — auto-detection
	   File/Blob in form values → FormData at runtime.
	   Schema types still see string — cast needed for typed routes.
	   For untyped routes or routes with z.any(), no cast needed.
	   ================================================================ */

	const file = new File(["content"], "report.pdf", { type: "application/pdf" })
	const upload = await api.post("/rs/form-upload", {
		form: { file: file as unknown as string, name: "Q4 Report" },
	})
	if (!upload.error) console.log(upload.data.size)

	/* ================================================================
	   WS: WebSocket — all features
	   ================================================================ */

	/* basic echo with send buffering (sends before OPEN are queued) */
	const echoWs = api.ws("/ws/echo")
	echoWs.send("buffered before open")
	echoWs.on("open", () => {
		echoWs.send("after open")
		echoWs.send({ structured: true })
	})
	echoWs.on("message", (data) => console.log(data))
	echoWs.on("close", (code, reason) => console.log(code, reason))
	echoWs.on("error", (err) => console.log(err))

	/* WS with path params + search (auth via query) */
	const chatWs = api.ws("/ws/chat/:channelId", {
		params: { channelId: "general" },
		search: { token: "ws-auth-token" },
	})
	chatWs.send("hey everyone")

	/* WS with reconnection token */
	const reconnectWs = api.ws("/ws/reconnect", {
		reconnectToken: "previous-session-token",
	})
	reconnectWs.on("message", (data) => console.log(data))

	/* WS off() — remove listener to avoid memory leaks */
	const handler = (data: string) => console.log(data)
	echoWs.on("message", handler)
	echoWs.off("message", handler)

	/* WS close */
	echoWs.close(1000, "done")
	chatWs.close()
	reconnectWs.close()
	console.log(echoWs.readyState)

	/* ================================================================
	   ERROR HANDLING — tuple mode
	   ================================================================ */

	/* server error → { data: null, error: ClientError } */
	const bad = await api.post("/out/multi-status", { json: { slug: "" } })
	if (bad.error) {
		console.log(bad.error.errorKey)
		console.log(bad.error.status)
		console.log(bad.error.statusKey)
		console.log(bad.error.message)
		console.log(bad.error.fields)

		/* response body still readable */
		const body = await bad.response.json()
		console.log(body)
	}

	/* network error — always throws regardless of throwOnError */
	try {
		const down = createClient<typeof app>({ baseURL: "http://localhost:99999" })
		await down.get("/in/none")
	} catch (e) {
		if (!isClientError(e)) {
			console.log("network error:", e)
		}
	}
}

main()
