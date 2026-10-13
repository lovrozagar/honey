import { honey } from "@lovrozagar/honey"

/**
 * A downstream service behind the gateway. In production it would be its own Worker reached
 * through a service binding; here the gateway's proxy calls its `fetch` directly.
 */
export const users = honey()

users.get("/users/").handler((ctx) => ctx.res.json("ok", { service: "users", users: [] }))

users.get("/users/:id/").handler((ctx) => ctx.res.json("ok", { id: ctx.params.id, service: "users" }))
