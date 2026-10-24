/**
 * The discovery fixture (bit 17 phase e): the shapes discovery has rules for, apart from the shop's command tree. It
 * holds:
 * - a summary of two sentences whose first runs past 80 characters, and a word only a summary carries (`tree`);
 * - an enum of 7 values (`<enum:7>` in the index) beside one of 2, and a required integer flag;
 * - a recursive schema (`Node`, its children `Node[]`) and an object nested past depth 3;
 * - honey's error envelope on 409 and 422 with their keys, a 400 with a plain JSON body, and a 404 with none;
 * - a hostile operation: control characters (ESC, CR, NEL, DEL, U+2028, the BOM) in its summary, an enum value, a
 *   field name;
 * - six commands whose path holds `get` or `list`, past search's 5.
 * It declares the server http://127.0.0.1:1.
 */
type Json = Record<string, unknown>

const STRING = { type: "string" }
const json = (schema: Json) => ({ content: { "application/json": { schema } } })
const ok = (schema: Json) => ({ 200: { ...json(schema), description: "ok" } })

/** The controls a hostile spec carries. */
export const HOSTILE = "\u001b[2J\r\n\u0085\u007f\u2028\ufeff"

/** honey's error envelope for `status`, its keys `keys`. */
const envelope = (status: number, keys: string[]) => ({
	properties: {
		error_key: { enum: keys, type: "string" },
		fields: { additionalProperties: { items: { $ref: "#/components/schemas/Field" }, type: "array" }, type: "object" },
		message: STRING,
		status: { enum: [status], type: "integer" },
		status_key: STRING,
		success: { const: false },
	},
	type: "object",
})

/** An object `depth` levels deep, a string at its bottom. */
const nested = (depth: number): Json =>
	depth === 0 ? STRING : { properties: { next: nested(depth - 1) }, required: ["next"], type: "object" }

/** `/deep` (nested past depth 3) and `/hostile` (controls in its summary, an enum value, a field name). */
const otherPaths = (): Json => ({
	"/deep": { get: { operationId: "deep.get", responses: ok(nested(5)) } },
	"/hostile": {
		get: {
			operationId: "hostile.get",
			parameters: [{ in: "query", name: "mode", schema: { enum: [`a${HOSTILE}b`, "c|d"], type: "string" } }],
			responses: ok({ properties: { [`we${HOSTILE}ird`]: STRING }, type: "object" }),
			summary: `Evil${HOSTILE} summary.`,
		},
	},
})

/** `/nodes`: an enum of 7 and one of 2, a required integer; `/nodes/{id}`: the recursive Node, a long summary. */
const nodePaths = (): Json => ({
	"/nodes": {
		get: {
			operationId: "nodes.list",
			parameters: [
				{ in: "query", name: "page", required: true, schema: { type: "integer" } },
				{ in: "query", name: "order", schema: { enum: ["asc", "desc"], type: "string" } },
				{
					in: "query",
					name: "color",
					schema: { enum: ["red", "orange", "yellow", "green", "blue", "indigo", "violet"], type: "string" },
				},
			],
			responses: ok({ items: { $ref: "#/components/schemas/Node" }, type: "array" }),
			summary: "List the nodes.",
		},
	},
	"/nodes/{id}": {
		get: {
			operationId: "nodes.get",
			parameters: [{ in: "path", name: "id", required: true, schema: STRING }],
			responses: ok({ $ref: "#/components/schemas/Node" }),
			summary:
				"Get one node of the tree with every child below it, as far down as the tree goes, depth first. Children nest.",
		},
	},
})

/** `/orgs`: a create with honey's envelope on 409 and 422 and a bare 404, a list; `/orgs/{id}`: a get. */
const orgPaths = (): Json => ({
	"/orgs": {
		get: { operationId: "orgs.list", responses: ok({ items: STRING, type: "array" }) },
		post: {
			operationId: "orgs.create",
			requestBody: { required: true, ...json({ properties: { slug: STRING }, required: ["slug"], type: "object" }) },
			responses: {
				...ok(STRING),
				400: { ...json({ properties: { message: STRING }, type: "object" }), description: "bad" },
				404: { description: "gone" },
				409: { ...json(envelope(409, ["org_slug_taken"])), description: "taken" },
				422: { ...json(envelope(422, ["invalid_input", "slug_too_long"])), description: "invalid" },
			},
			summary: "Create an org",
		},
	},
	"/orgs/{id}": {
		get: {
			operationId: "orgs.get",
			parameters: [{ in: "path", name: "id", required: true, schema: STRING }],
			responses: ok(STRING),
		},
	},
})

/** The catalog document. */
export const catalog = (): Json => ({
	components: {
		schemas: {
			Field: { properties: { error_key: STRING, message: STRING, path: STRING }, type: "object" },
			Node: {
				properties: { children: { items: { $ref: "#/components/schemas/Node" }, type: "array" }, id: STRING },
				required: ["id"],
				type: "object",
			},
		},
	},
	info: { title: "Catalog", version: "1" },
	openapi: "3.1.0",
	paths: { ...otherPaths(), ...nodePaths(), ...orgPaths() },
	servers: [{ url: "http://127.0.0.1:1" }],
})
