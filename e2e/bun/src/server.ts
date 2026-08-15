import { createApp } from "@honey/e2e-app"
import { bunWebSocket } from "honey/ws/bun"

const bunWs = bunWebSocket()
const app = createApp(bunWs)
const port = Number(process.env.PORT ?? 4100)

Bun.serve({
	fetch: (req, server) => app.fetch(req, { server }),
	hostname: "0.0.0.0",
	port,
	websocket: bunWs.websocket,
})

process.stdout.write(`Honey Bun E2E on :${port}\n`)
