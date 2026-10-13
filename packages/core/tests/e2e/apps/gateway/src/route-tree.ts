import { mergeTree } from "@lovrozagar/honey"
import { users } from "./users.ts"

/**
 * `codegen.mergeTree` source: the downstream routes the gateway forwards. `honey generate`
 * adds the gateway's own routes and writes the result to `_gen/routes.gen.ts`.
 */
export const tree = mergeTree([users.toRouteTree(), { worker: "origin" }])
