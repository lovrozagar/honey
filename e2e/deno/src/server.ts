import { createApp } from "@honey/e2e-app"
import { denoWebSocket } from "@ecomet/honey/ws/deno"

const app = createApp(denoWebSocket())
const port = Number(Deno.env.get("PORT") ?? "4103")

Deno.serve({ hostname: "0.0.0.0", port }, (req) => app.fetch(req, {}))
