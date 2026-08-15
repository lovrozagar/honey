import { createApp } from "@honey/e2e-app"

const app = createApp()
const port = Number(process.env.PORT ?? 4101)

await app.serve({ hostname: "0.0.0.0", port, runtime: "node" })
process.stdout.write(`Honey Node E2E on :${port}\n`)
