import { stubWs } from "../../stub-ws.ts"
import { createApp } from "./app.ts"

export const app = createApp(stubWs)
