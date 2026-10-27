import { serve } from "@lovrozagar/honey/serve"
import { loadE2eApp } from "../../load.ts"

const app = loadE2eApp(process.env.HONEY_E2E_APP)
const port = Number(process.env.PORT ?? 4101)

await serve(app, { hostname: "0.0.0.0", port })
process.stdout.write(`Honey Node E2E (${process.env.HONEY_E2E_APP ?? "kitchen"}) on :${port}\n`)
