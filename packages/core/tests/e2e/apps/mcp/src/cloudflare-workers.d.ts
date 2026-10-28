/** `cloudflare:workers` as far as uploads-store.cloudflare.ts reads it, for this app's tsconfig (no Workers types). */
declare module "cloudflare:workers" {
	export const env: Record<string, unknown>
}
