// A TypeScript program against an SDK generated from the Kitchen example API: a client, a call and its typed error,
// safe mode, and an event stream released by leaving its loop. Type-checked against the generated SDK in the docs' tests.
import { Kitchen, NotFoundError } from "./kitchen"

export function newClient(): Kitchen<true> {
	return new Kitchen({
		baseURL: "https://api.example.com",
		headers: { authorization: `Bearer ${process.env.KITCHEN_TOKEN ?? ""}` },
		throwOnError: true,
		timeout: 10_000,
	})
}

export async function organization(client: Kitchen<true>, orgId: string): Promise<string | null> {
	try {
		await client.getApiV1OrganizationsByOrgId({ params: { orgId } })
		return orgId
	} catch (error) {
		if (error instanceof NotFoundError) return null
		throw error
	}
}

export async function healthInSafeMode(): Promise<string> {
	const client = new Kitchen({ baseURL: "https://api.example.com" })
	const result = await client.getApiHealth()
	return result.error === null ? "up" : `answered ${result.status}`
}

export async function firstEvents(client: Kitchen<true>, limit: number): Promise<string[]> {
	const seen: string[] = []
	for await (const event of client.getApiEvents()) {
		seen.push(String(event.data))
		if (seen.length === limit) break // leaving the loop frees the connection
	}
	return seen
}
