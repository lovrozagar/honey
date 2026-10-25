/**
 * A local TLS server offering h2 and http/1.1 by ALPN (bit 19 d2), recording each request's negotiated protocol, so a
 * leg can hold an SDK to HTTP/1.1 when a server would speak h2. A child process trusts the CA through SSL_CERT_FILE
 * (Go, Rust, OpenSSL) or NODE_EXTRA_CA_CERTS (Node, Bun), which `trusted` sets for the span of one run.
 *
 * TEST-ONLY, INSECURE KEY MATERIAL, PUBLISHED ON PURPOSE: the CA ("honey test CA (test only, insecure)"), the leaf
 * ("honey test leaf for 127.0.0.1 (test only, insecure)", valid to 2126) and the leaf's private key below exist only so
 * this fixture can speak TLS on loopback. The CA's own key was discarded when it signed the leaf. None of it protects
 * anything; never trust this CA or reuse this key outside a test.
 */
import { mkdirSync, writeFileSync } from "node:fs"
import { createSecureServer } from "node:http2"
import type { AddressInfo } from "node:net"
import type { TLSSocket } from "node:tls"
import { homedir } from "node:os"
import { join } from "node:path"

const CA = `-----BEGIN CERTIFICATE-----
MIIBtDCCAVmgAwIBAgIUcwFItJwaUN+PE+KYtKvpUT7WWJ0wCgYIKoZIzj0EAwIw
LjEsMCoGA1UEAwwjaG9uZXkgdGVzdCBDQSAodGVzdCBvbmx5LCBpbnNlY3VyZSkw
IBcNMjYxMDI1MTEwODUzWhgPMjEyNjEwMDExMTA4NTNaMC4xLDAqBgNVBAMMI2hv
bmV5IHRlc3QgQ0EgKHRlc3Qgb25seSwgaW5zZWN1cmUpMFkwEwYHKoZIzj0CAQYI
KoZIzj0DAQcDQgAEZg0XzZeg3paR/wKjOrfUGnCLhuw6FEe55OXvkwTJXF8ahWl0
jQVL3LAy0C+pGC8rgJlca17OUmOXJT0tqkTcMKNTMFEwHQYDVR0OBBYEFKvk/PaW
pvMeQQcl24hIcsFmnylLMB8GA1UdIwQYMBaAFKvk/PaWpvMeQQcl24hIcsFmnylL
MA8GA1UdEwEB/wQFMAMBAf8wCgYIKoZIzj0EAwIDSQAwRgIhANg9ddVbKwOfsZ+Q
Al8bQyLD0DSz3wPGuw39glTnxDz8AiEA1R3siccMb3drmg1f9ycEI4UWHuzscf44
YXpOy2QFxzw=
-----END CERTIFICATE-----`

const CERT = `-----BEGIN CERTIFICATE-----
MIIB8jCCAZegAwIBAgIUWaPR+5SwzKa4ba6Zlx4IooJeFyAwCgYIKoZIzj0EAwIw
LjEsMCoGA1UEAwwjaG9uZXkgdGVzdCBDQSAodGVzdCBvbmx5LCBpbnNlY3VyZSkw
IBcNMjYxMDI1MTEwODUzWhgPMjEyNjEwMDExMTA4NTNaMD4xPDA6BgNVBAMMM2hv
bmV5IHRlc3QgbGVhZiBmb3IgMTI3LjAuMC4xICh0ZXN0IG9ubHksIGluc2VjdXJl
KTBZMBMGByqGSM49AgEGCCqGSM49AwEHA0IABB/AqWgOXvFjZfVbz25+8vqA9z9G
Mn1/iqwYqE4ioeweLSQxXxQXRkgHII/9HrWBX01loapmRSoPc/7P1ezWlA6jgYAw
fjAPBgNVHREECDAGhwR/AAABMAkGA1UdEwQCMAAwCwYDVR0PBAQDAgeAMBMGA1Ud
JQQMMAoGCCsGAQUFBwMBMB0GA1UdDgQWBBTk28TrFszHgpRVDP5QAvTBOySgozAf
BgNVHSMEGDAWgBSr5Pz2lqbzHkEHJduISHLBZp8pSzAKBggqhkjOPQQDAgNJADBG
AiEAjk0b+9qbvbnovjhY186FcbMVVetH3Rym7ooN/dOJkrwCIQDx/XWYwmHZDkbM
fow2/5aBFSO3LzQFApoVf5aoC5Jyhw==
-----END CERTIFICATE-----`

const KEY = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgrAyBex/B/QEesTp5
N/R4xqzxcS9/bH5SrmSKWUXFZgKhRANCAAQfwKloDl7xY2X1W89ufvL6gPc/RjJ9
f4qsGKhOIqHsHi0kMV8UF0ZIByCP/R61gV9NZaGqZkUqD3P+z9Xs1pQO
-----END PRIVATE KEY-----`

/** One request as the server saw it: the ALPN protocol its TLS session negotiated, and its HTTP version. */
export type Negotiated = { readonly alpn: string | false | null; readonly version: string }

export type AlpnServer = {
	readonly url: string
	/** each request's negotiated protocol, in arrival order */
	seen(): readonly Negotiated[]
	close(): Promise<void>
}

/** A TLS server on an OS-picked loopback port, answering every request `{}` as JSON. */
export async function alpnServer(): Promise<AlpnServer> {
	const seen: Negotiated[] = []
	const server = createSecureServer({ allowHTTP1: true, cert: CERT, key: KEY }, (req, res) => {
		seen.push({ alpn: (req.socket as TLSSocket).alpnProtocol ?? null, version: req.httpVersion })
		res.writeHead(200, { "content-type": "application/json" })
		res.end("{}")
	})
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
	const { port } = server.address() as AddressInfo
	return {
		close: () => new Promise<void>((resolve) => server.close(() => resolve())),
		seen: () => seen,
		url: `https://127.0.0.1:${port}`,
	}
}

/** `run` with SSL_CERT_FILE naming the test CA, so the child processes it spawns trust the server; restored after. */
export async function trusted<T>(run: () => Promise<T>): Promise<T> {
	const dir = join(process.env.HOME ?? homedir(), ".cache/honey-tmp/tls")
	mkdirSync(dir, { recursive: true })
	const file = join(dir, "test-ca.pem")
	writeFileSync(file, `${CA}\n`)
	const before = process.env.SSL_CERT_FILE
	process.env.SSL_CERT_FILE = file
	try {
		return await run()
	} finally {
		if (before === undefined) delete process.env.SSL_CERT_FILE
		else process.env.SSL_CERT_FILE = before
	}
}
