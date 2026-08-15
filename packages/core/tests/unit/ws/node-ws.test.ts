import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type PongCb = () => void;
type CloseCb = (code: number, reason: Buffer) => void;
type ErrorCb = (err: unknown) => void;
type MessageCb = (
	data: Buffer | ArrayBuffer | Buffer[],
	isBinary: boolean,
) => void;

type FakeWS = {
	_listeners: Record<string, Array<(...args: unknown[]) => void>>;
	close: ReturnType<typeof vi.fn>;
	on: (event: string, cb: (...args: unknown[]) => void) => void;
	ping: ReturnType<typeof vi.fn>;
	readyState: number;
	send: ReturnType<typeof vi.fn>;
};

function createFakeWS(): FakeWS {
	const listeners: Record<string, Array<(...args: unknown[]) => void>> = {};
	return {
		_listeners: listeners,
		close: vi.fn(),
		on(event: string, cb: (...args: unknown[]) => void) {
			if (listeners[event] === undefined) listeners[event] = [];
			listeners[event].push(cb);
		},
		ping: vi.fn(),
		readyState: 1,
		send: vi.fn(),
	};
}

let fakeWS: FakeWS;

vi.mock("ws", () => ({
	WebSocketServer: class {
		handleUpgrade(
			_req: unknown,
			_socket: unknown,
			_head: unknown,
			cb: (ws: FakeWS) => void,
		) {
			cb(fakeWS);
		}
	},
}));

describe("nodeWebSocket", () => {
	beforeEach(() => {
		fakeWS = createFakeWS();
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	async function getAdapter(keepalive?: { interval: number; timeout: number }) {
		const { nodeWebSocket } = await import("../../../src/ws/node.ts");
		return nodeWebSocket(keepalive ? { keepalive } : undefined);
	}

	function makeEnv() {
		return {
			__nodeUpgrade: {
				head: Buffer.alloc(0),
				req: {},
				socket: {},
			},
		};
	}

	it("text message → handler.onMessage receives string", async () => {
		const adapter = await getAdapter();
		const onMessage = vi.fn();
		const handler = { onMessage, onOpen: vi.fn() };

		await adapter.upgrade(
			new Request("http://localhost/ws"),
			makeEnv(),
			handler,
		);

		const msgCb = fakeWS._listeners["message"]?.[0] as MessageCb;
		msgCb(Buffer.from("hello"), false);

		expect(onMessage).toHaveBeenCalledWith(
			undefined,
			expect.anything(),
			"hello",
		);
	});

	it("binary Buffer message → handler.onMessage receives ArrayBuffer", async () => {
		const adapter = await getAdapter();
		const onMessage = vi.fn();

		await adapter.upgrade(new Request("http://localhost/ws"), makeEnv(), {
			onMessage,
		});

		const msgCb = fakeWS._listeners["message"]?.[0] as MessageCb;
		msgCb(Buffer.from([1, 2, 3]), true);

		expect(onMessage).toHaveBeenCalled();
		const data = onMessage.mock.calls[0][2];
		expect(data).toBeInstanceOf(ArrayBuffer);
		expect(new Uint8Array(data)).toEqual(new Uint8Array([1, 2, 3]));
	});

	it("Buffer[] (fragmented) → merged ArrayBuffer", async () => {
		const adapter = await getAdapter();
		const onMessage = vi.fn();

		await adapter.upgrade(new Request("http://localhost/ws"), makeEnv(), {
			onMessage,
		});

		const msgCb = fakeWS._listeners["message"]?.[0] as MessageCb;
		msgCb([Buffer.from([1, 2]), Buffer.from([3, 4])], true);

		expect(onMessage).toHaveBeenCalled();
		const data = onMessage.mock.calls[0][2];
		expect(data).toBeInstanceOf(ArrayBuffer);
		expect(new Uint8Array(data)).toEqual(new Uint8Array([1, 2, 3, 4]));
	});

	it("raw ArrayBuffer passes through", async () => {
		const adapter = await getAdapter();
		const onMessage = vi.fn();

		await adapter.upgrade(new Request("http://localhost/ws"), makeEnv(), {
			onMessage,
		});

		const msgCb = fakeWS._listeners["message"]?.[0] as MessageCb;
		const ab = new ArrayBuffer(2);
		msgCb(ab as unknown as Buffer, true);

		expect(onMessage).toHaveBeenCalledWith(undefined, expect.anything(), ab);
	});

	it("close event → calls handler.onClose and clears timers", async () => {
		const adapter = await getAdapter({ interval: 1000, timeout: 500 });
		const onClose = vi.fn();

		await adapter.upgrade(new Request("http://localhost/ws"), makeEnv(), {
			onClose,
		});

		const closeCb = fakeWS._listeners["close"]?.[0] as CloseCb;
		closeCb(1000, Buffer.from("normal"));

		expect(onClose).toHaveBeenCalledWith(
			undefined,
			expect.anything(),
			1000,
			"normal",
		);
	});

	it("error event → calls handler.onError", async () => {
		const adapter = await getAdapter();
		const onError = vi.fn();

		await adapter.upgrade(new Request("http://localhost/ws"), makeEnv(), {
			onError,
		});

		const errorCb = fakeWS._listeners["error"]?.[0] as ErrorCb;
		const err = new Error("test");
		errorCb(err);

		expect(onError).toHaveBeenCalledWith(undefined, expect.anything(), err);
	});

	it("keepalive: ping sent on interval, pong resets timeout", async () => {
		const adapter = await getAdapter({ interval: 1000, timeout: 500 });

		await adapter.upgrade(new Request("http://localhost/ws"), makeEnv(), {});

		/* advance past interval → ping should fire */
		vi.advanceTimersByTime(1000);
		expect(fakeWS.ping).toHaveBeenCalledTimes(1);

		/* pong received → clears timeout */
		const pongCb = fakeWS._listeners["pong"]?.[0] as PongCb;
		pongCb();

		/* no close should be called */
		vi.advanceTimersByTime(500);
		expect(fakeWS.close).not.toHaveBeenCalled();
	});

	it("keepalive: no pong → close(1001)", async () => {
		const adapter = await getAdapter({ interval: 1000, timeout: 500 });

		await adapter.upgrade(new Request("http://localhost/ws"), makeEnv(), {});

		/* trigger ping */
		vi.advanceTimersByTime(1000);
		expect(fakeWS.ping).toHaveBeenCalledTimes(1);

		/* no pong, wait for timeout */
		vi.advanceTimersByTime(500);
		expect(fakeWS.close).toHaveBeenCalledWith(1001, "keepalive timeout");
	});

	it("response has status 101", async () => {
		const adapter = await getAdapter();

		const result = await adapter.upgrade(
			new Request("http://localhost/ws"),
			makeEnv(),
			{},
		);

		expect(result.response.status).toBe(101);
	});

	it("onOpen called after upgrade", async () => {
		const adapter = await getAdapter();
		const onOpen = vi.fn();

		await adapter.upgrade(new Request("http://localhost/ws"), makeEnv(), {
			onOpen,
		});

		expect(onOpen).toHaveBeenCalledWith(undefined, expect.anything());
	});
});
