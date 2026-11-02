/** The cloudflare bundle's entry: the app with the Workers WebSocketPair WebSocket adapter; gen-app.ts's stub is for generation only. */
import { workersWebSocket } from "@lovrozagar/honey/ws/workers"
import { createApp } from "./app.ts"

export const app = createApp(workersWebSocket())
