const encoder = new TextEncoder()

let cachedKey: CryptoKey | null = null

async function getKey(): Promise<CryptoKey> {
	if (cachedKey === null) {
		cachedKey = await crypto.subtle.generateKey({ hash: "SHA-256", name: "HMAC" }, false, [
			"sign",
			"verify",
		])
	}
	return cachedKey
}

export async function timingSafeEqual(a: string, b: string): Promise<boolean> {
	const key = await getKey()
	const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(a))
	return crypto.subtle.verify("HMAC", key, sig, encoder.encode(b))
}
