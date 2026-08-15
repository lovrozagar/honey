const encoder = new TextEncoder()

function importKey(secret: string): Promise<CryptoKey> {
	return crypto.subtle.importKey("raw", encoder.encode(secret), { hash: "SHA-256", name: "HMAC" }, false, [
		"sign",
		"verify",
	])
}

function toBase64Url(buffer: ArrayBuffer): string {
	const bytes = new Uint8Array(buffer)
	let binary = ""
	for (let i = 0; i < bytes.length; i++) {
		binary += String.fromCharCode(bytes[i])
	}
	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

function fromBase64Url(str: string): Uint8Array {
	const padded = str.replace(/-/g, "+").replace(/_/g, "/")
	const binary = atob(padded)
	const bytes = new Uint8Array(binary.length)
	for (let i = 0; i < binary.length; i++) {
		bytes[i] = binary.charCodeAt(i)
	}
	return bytes
}

export async function sign(value: string, secret: string): Promise<string> {
	const key = await importKey(secret)
	const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(value))
	return `${value}.${toBase64Url(signature)}`
}

export async function verify(signed: string, secrets: string[]): Promise<string | null> {
	if (signed.length === 0) return null
	const lastDot = signed.lastIndexOf(".")
	if (lastDot === -1) return null

	const value = signed.slice(0, lastDot)
	const sig = fromBase64Url(signed.slice(lastDot + 1))

	for (const secret of secrets) {
		const key = await importKey(secret)
		const valid = await crypto.subtle.verify("HMAC", key, sig.buffer as ArrayBuffer, encoder.encode(value))
		if (valid) return value
	}

	return null
}
