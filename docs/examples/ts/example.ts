// A TypeScript program against an SDK generated from the Kitchen example API: a client, a call and its typed error,
// the call's safe twin answering a Result, and an event stream released by leaving its loop. Type-checked against the
// generated SDK in the docs' tests.
import { DecodeError, Kitchen, NotFoundError } from "./kitchen"

export function newClient(): Kitchen {
	return new Kitchen({
		baseURL: "https://api.example.com",
		headers: { authorization: `Bearer ${process.env.KITCHEN_TOKEN ?? ""}` },
		timeout: 10_000,
	})
}

export async function organization(client: Kitchen, orgId: string): Promise<string | null> {
	try {
		await client.getApiV1OrganizationsByOrgId({ params: { orgId } })
		return orgId
	} catch (error) {
		if (error instanceof NotFoundError) return null
		throw error
	}
}

export async function health(client: Kitchen): Promise<string> {
	const result = await client.safe.getApiHealth()
	if (result.ok) return "up"
	if (result.error instanceof DecodeError) return `unreadable answer: ${result.error.message}`
	return `answered ${result.error.status}`
}

export async function firstEvents(client: Kitchen, limit: number): Promise<string[]> {
	const seen: string[] = []
	for await (const event of client.getApiEvents()) {
		seen.push(String(event.data))
		if (seen.length === limit) break // leaving the loop frees the connection
	}
	return seen
}
