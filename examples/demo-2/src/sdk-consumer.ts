/**
 * Real SDK consumer — safe mode (default), same as createClient.
 * Returns { data, error, response, status } tuple.
 */

import { createDemo2SDK } from "./honey.sdk.gen"

const sdk = createDemo2SDK({
	baseURL: "http://localhost:3000",
	headers: { authorization: "Bearer test-token" },
})

async function main() {
	/* ================================================================
	   TUPLE MODE (default) — { data, error, response, status }
	   ================================================================ */

	/* success → data is typed, error is null */
	const { data, error } = await sdk.input.createJson({
		json: { email: "alice@test.com", name: "Alice" },
	})

	if (error) {
		console.log(error.errorKey, error.status)
		return
	}
	console.log("created.id:", data.id)
	/*                         ^ string — narrowed afte error check */

	/* no-input route */
	const pong = await sdk.input.none()
	if (!pong.error) {
		console.log("pong.ping:", pong.data.ping)
		/*                        ^ "pong" literal */
	}

	/* search params */
	const searched = await sdk.input.search({
		search: { limit: 10, page: 1, q: "test" },
	})
	if (!searched.error) {
		console.log("results:", searched.data.results)
		/*                      ^ string[] */
	}

	/* CRUD */
	const items = await sdk.resources.list()
	if (!items.error) console.log("items:", items.data.items)

	const created = await sdk.resources.create({ json: { name: "Widget" } })
	if (!created.error) console.log("newItem.id:", created.data.id)

	const updated = await sdk.resources.update({
		json: { name: "Updated" },
		params: { id: "42" },
	})
	if (!updated.error) console.log("updated:", updated.data.id, updated.data.name)

	const deleted = await sdk.resources.delete({ params: { id: "1" } })
	console.log("deleted status:", deleted.status)

	/* error handling */
	const bad = await sdk.input.createJson({
		json: { name: "no-email" } as { email: string; name: string },
	})
	if (bad.error) {
		console.log("error:", bad.error.errorKey, bad.error.status)
	}

	console.log("\nAll SDK calls with tuple mode!")
}

main().catch(console.error)
