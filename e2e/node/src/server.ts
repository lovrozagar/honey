import { createApp } from "@honey/e2e-app"
import { serve } from "@ecomet/honey/node"
import { nodeWebSocket } from "@ecomet/honey/ws/node"

const app = createApp(nodeWebSocket())
const port = Number(process.env.PORT ?? 4101)

serve(app, { env: {}, hostname: "0.0.0.0", port })
process.stdout.write(`Honey Node E2E on :${port}\n`)
