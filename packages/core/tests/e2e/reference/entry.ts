/** The honey-free reference build's entry: a fetch handler with no honey in its graph (vite.config.ts says why). */
export default {
	fetch: (request: Request): Response => new Response(new URL(request.url).pathname),
}
