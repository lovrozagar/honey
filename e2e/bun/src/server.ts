import { loadE2eApp } from "../../apps/load.ts"

const app = loadE2eApp(process.env.HONEY_E2E_APP)
const port = Number(process.env.PORT ?? 4100)

await app.serve({ hostname: "0.0.0.0", port })
process.stdout.write(`Honey Bun E2E (${process.env.HONEY_E2E_APP ?? "kitchen"}) on :${port}\n`)
