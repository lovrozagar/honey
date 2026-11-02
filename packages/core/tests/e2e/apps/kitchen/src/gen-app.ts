import type { WSAdapter } from "@lovrozagar/honey"
import { createApp } from "./app.ts"
import { events } from "./events.ts"

const stubWs: WSAdapter = {
	upgrade() {
		return {
			response: new Response("unused", { status: 426 }),
			socket: {
				close() {},
				raw: { close() {}, readyState: 3, send() {} },
				get readyState() {
					return 3 as const
				},
				send() {},
			},
		}
	},
}

export const app = createApp(stubWs)

/* what `honey-clients generate --app` documents the SDK from: kitchen's routes and its webhook events */
export const openApi = { info: { title: "Honey E2E", version: "0.0.1" }, webhooks: events }
