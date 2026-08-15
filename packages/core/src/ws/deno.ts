export {
	type RawSocket,
	type WSAdapter,
	type WSContext,
	WSContextImpl,
	type WSHandler,
} from "./cloudflare.ts";

import type { WSAdapter, WSHandler } from "./cloudflare.ts";
import { WSContextImpl } from "./cloudflare.ts";

type DenoNs = {
	Deno: {
		upgradeWebSocket(req: Request): {
			response: Response;
			socket: {
				addEventListener(
					type: string,
					listener: (...args: never[]) => void,
				): void;
			} & DenoRawSocket;
		};
	};
};

type DenoRawSocket = {
	close(code?: number, reason?: string): void;
	readyState: number;
	send(data: ArrayBuffer | Uint8Array | string): void;
};

/**
 * Deno WebSocket adapter.
 * Uses Deno.upgradeWebSocket() and addEventListener for event binding.
 * Keepalive is not supported — Deno's WebSocket lacks a ping() method.
 * Use nodeWebSocket() for keepalive support.
 */
export function denoWebSocket(): WSAdapter {
	return {
		upgrade(req: Request, _env: unknown, handler: WSHandler<unknown>) {
			/* globalThis cast: Deno namespace only exists at runtime on Deno — no way to type it statically */
			const denoNs = globalThis as unknown as DenoNs;
			const { response, socket: rawSocket } = denoNs.Deno.upgradeWebSocket(req);
			const socket = new WSContextImpl(rawSocket as DenoRawSocket);

			rawSocket.addEventListener("open", () => {
				handler.onOpen?.(undefined, socket);
			});
			rawSocket.addEventListener(
				"message",
				(evt: { data: ArrayBuffer | string }) => {
					handler.onMessage?.(undefined, socket, evt.data);
				},
			);
			rawSocket.addEventListener(
				"close",
				(evt: { code: number; reason: string }) => {
					handler.onClose?.(undefined, socket, evt.code, evt.reason);
				},
			);
			rawSocket.addEventListener("error", (evt: unknown) => {
				handler.onError?.(undefined, socket, evt);
			});

			return { response, socket };
		},
	};
}
