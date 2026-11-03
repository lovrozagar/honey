import type { Server } from "bun"
import { type BunServer, serve } from "@lovrozagar/honey/bun"
import { loadE2eApp } from "../../load.ts"

const app = loadE2eApp(process.env.HONEY_E2E_APP)
const port = Number(process.env.PORT ?? 4100)

await serve(app, { hostname: "0.0.0.0", port })
process.stdout.write(`Honey Bun E2E (${process.env.HONEY_E2E_APP ?? "kitchen"}) on :${port}\n`)

/** Checked against the real bun-types: honey's `BunServer` stays a part of Bun's own `Server`, or this fails to compile. */
export const asBunServer = (server: Server<unknown>): BunServer => server
