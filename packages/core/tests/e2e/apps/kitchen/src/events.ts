import { webhookContract } from "@lovrozagar/honey/webhook"
import * as z from "zod"

/** The Standard Webhooks events kitchen declares: its OpenAPI document's webhooks, and what its sample route signs. */
export const events = webhookContract({
	"order.paid": z.object({ amount: z.number().int(), orderId: z.string() }),
	"order.refunded": z.object({ orderId: z.string(), reason: z.string() }),
})
