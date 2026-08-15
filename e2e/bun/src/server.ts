import { createApp } from "@honey/e2e-app"

const app = createApp()
const port = Number(process.env.PORT ?? 4100)

await app.serve({ hostname: "0.0.0.0", port })
process.stdout.write(`Honey Bun E2E on :${port}\n`)
