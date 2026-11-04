/**
 * The run the TS package tests share (plan 39 8.3): a document with every file kind the TS target writes, a run that
 * names a scoped package and fills its metadata, and the optional TanStack peer installed beside a written package.
 */
import { mkdirSync, symlinkSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { generated, type GenerateRun } from "../../../index.ts"

/** The repository root, whose node_modules holds the workspace's copy of the peer. */
export const REPO = /* @__PURE__ */ resolve(import.meta.dirname, "../../../../../..")

/** Every file kind the TS target writes: the realtime runtime (SSE and WebSocket with it), a webhook event, TanStack. */
export const DOCUMENT = {
	info: { title: "Shop", version: "1.2.0" },
	openapi: "3.1.0",
	paths: {
		"/feed": { get: { operationId: "feed", responses: { 101: { description: "ws" } }, "x-realtime": true } },
		"/items": {
			get: {
				operationId: "items.list",
				responses: { 200: { content: { "application/json": { schema: { type: "array" } } }, description: "ok" } },
			},
		},
	},
	servers: [{ url: "https://shop.example.test" }],
	webhooks: {
		"order.shipped": {
			post: {
				requestBody: {
					content: {
						"application/json": {
							schema: {
								properties: {
									data: { properties: { orderId: { type: "string" } }, required: ["orderId"], type: "object" },
									timestamp: { format: "date-time", type: "string" },
									type: { const: "order.shipped" },
								},
								required: ["type", "timestamp", "data"],
								type: "object",
							},
						},
					},
				},
				responses: { 200: { description: "ok" } },
				"x-honey-webhook": "standard-webhooks",
			},
		},
	},
}

export const RUN: GenerateRun = {
	metadata: {
		authors: ["Acme Inc <oss@acme.dev>"],
		description: "The Shop API's client",
		homepage: "https://acme.dev",
		keywords: ["shop", "api"],
		license: "MIT",
		repository: "https://github.com/acme/shop-ts",
	},
	options: { ts: { name: "Shop", packageName: "@acme/shop", tanstackQuery: "true", version: "1.2.0" } },
	targets: ["ts"],
}

/** The TS target's files for `run` over `document`. */
export async function tsFiles(run: GenerateRun = RUN, document = DOCUMENT): Promise<Readonly<Record<string, string>>> {
	return (await generated(run, document, { env: {}, report: () => undefined })).ts ?? {}
}

/** `dir` with the optional peer a TanStack consumer or a release brings installed: the workspace's own copy. */
export function withPeer(dir: string): string {
	const peer = join(dir, "node_modules/@tanstack/query-core")
	mkdirSync(dirname(peer), { recursive: true })
	symlinkSync(join(REPO, "node_modules/@tanstack/query-core"), peer)
	return dir
}
