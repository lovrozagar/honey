/** A form body as `.input({ form })` declares it. */
import type { BodyParser } from "../response/media-type.ts"
import type { StandardSchemaLike } from "../validation/standard-schema.ts"
import { runSchema, type Shape, shapedRecord, shapeOf } from "../validation/validate-input.ts"
import { malformedBody } from "./json.ts"

/** The multipart body's fields and files; a body that is not multipart is a 400 `malformed_body`. */
async function parts(req: Request): Promise<Iterable<[string, FormDataEntryValue]>> {
	/* read the bytes first: an error while reading passes through, only parsing them is the client's */
	const bytes = await req.arrayBuffer()
	/* the multipart parser was chosen from this header, so it is present: it carries the boundary */
	const contentType = req.headers.get("content-type") as string
	try {
		return await new Response(bytes, { headers: { "content-type": contentType } }).formData()
	} catch (error) {
		throw malformedBody("multipart", error)
	}
}

/**
 * The body read once as an urlencoded or multipart form and validated by `schema`. Repeated keys
 * follow `shape` (the schema's, computed once per route; the query's policy), and `__proto__`,
 * `constructor` and `prototype` never reach it.
 */
export async function formInput(
	schema: StandardSchemaLike,
	req: Request,
	parser: Exclude<BodyParser, "json">,
	shape: Shape | null = shapeOf(schema),
): Promise<unknown> {
	const entries = parser === "urlencoded" ? new URLSearchParams(await req.text()) : await parts(req)
	return runSchema(schema, shapedRecord<FormDataEntryValue>(entries, shape), "form")
}
