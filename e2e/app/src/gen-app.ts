import type { WSAdapter } from "honey"
import { createApp } from "./app.ts"

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
