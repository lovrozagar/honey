import { createApp } from "@honey/e2e-app"

const app = createApp()
const port = Number(Deno.env.get("PORT") ?? "4103")

/* 127.0.0.1: Playwright's Node HTTP client prefers ::1 for `localhost`,
 * and Deno.serve({ hostname: "0.0.0.0" }) is IPv4-only. */
await app.serve({ hostname: "127.0.0.1", port, runtime: "deno" })
