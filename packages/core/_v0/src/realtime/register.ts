/**
 * `import "@lovrozagar/honey/realtime"` makes `app.realtime()` available. The core never
 * imports the realtime server, so an app without realtime routes does not bundle it.
 */
import { registerFeature } from "../feature-slots.ts"
import { createBus } from "./bus.ts"
import { resolveRealtimeConfig } from "./route.ts"
import { createRealtimePublisher, createRealtimeSession } from "./server.ts"

registerFeature("realtime", { createBus, createRealtimePublisher, createRealtimeSession, resolveRealtimeConfig })

export type { ConnContext, RealtimeLimits, RealtimeRouteOpts } from "./route.ts"
export type { RealtimePublisher } from "./server.ts"
