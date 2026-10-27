/** The bun bundle's entry: the app with Bun's own WebSocket adapter; gen-app.ts's stub is for generation only. */
import { bunWebSocket } from "@lovrozagar/honey/ws/bun"
import { createApp } from "./app.ts"

export const app = createApp(bunWebSocket())
