/** The node bundle's entry: the app with ws, on node:http WebSocket adapter; gen-app.ts's stub is for generation only. */
import { nodeWebSocket } from "@lovrozagar/honey/ws/node"
import { createApp } from "./app.ts"

export const app = createApp(nodeWebSocket())
