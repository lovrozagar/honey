import { describe, expect, it } from "vitest";
import { bunWebSocket } from "../../../src/ws/bun.ts";

describe("Bun WS adapter: socket init race condition", () => {
	it("message() before open() should not pass undefined socket to handler", () => {
		const adapter = bunWebSocket();

		const receivedSockets: Array<unknown> = [];
		const handler = {
			onMessage(ctx: unknown, ws: unknown, data: unknown) {
				void ctx;
				void data;
				receivedSockets.push(ws);
			},
			onOpen(ctx: unknown, ws: unknown) {
				void ctx;
				receivedSockets.push(ws);
			},
		};

		/* simulate Bun's ws.data after upgrade — socket is undefined initially */
		const fakeRawWs = {
			close() {},
			data: { handler, socket: undefined as unknown },
			readyState: 1,
			send() {
				return 0;
			},
		};

		/* message arrives BEFORE open (race condition) */
		adapter.websocket.message(fakeRawWs as never, "hello");

		/* socket passed to onMessage should NOT be undefined */
		expect(receivedSockets[0]).not.toBeUndefined();
	});

	it("close() before open() should not pass undefined socket to handler", () => {
		const adapter = bunWebSocket();

		const receivedSockets: Array<unknown> = [];
		const handler = {
			onClose(ctx: unknown, ws: unknown, code: number, reason: string) {
				void ctx;
				void code;
				void reason;
				receivedSockets.push(ws);
			},
		};

		const fakeRawWs = {
			close() {},
			data: { handler, socket: undefined as unknown },
			readyState: 3,
			send() {
				return 0;
			},
		};

		adapter.websocket.close(fakeRawWs as never, 1000, "normal");

		expect(receivedSockets[0]).not.toBeUndefined();
	});
});
