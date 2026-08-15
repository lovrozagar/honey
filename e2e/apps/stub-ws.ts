import type { WSAdapter } from "honey"

/** Used by honey generate so apps that accept a WS adapter still export a Honey instance. */
export const stubWs: WSAdapter = {
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
