import { loadE2eApp } from "../../apps/load.ts"

const app = loadE2eApp(Deno.env.get("HONEY_E2E_APP") ?? undefined)
const port = Number(Deno.env.get("PORT") ?? "4103")

/* 127.0.0.1: Playwright's Node HTTP client prefers ::1 for `localhost`,
 * and Deno.serve({ hostname: "0.0.0.0" }) is IPv4-only. */
await app.serve({ hostname: "127.0.0.1", port, runtime: "deno" })
