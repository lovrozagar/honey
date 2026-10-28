/**
 * A tool's file argument as its inputSchema shows it (bit 21 c): the provisional file-uploads extension's FileInput
 * (its draft at PR head 6101d34), an object schema marked `x-mcp-file` requiring the members the draft
 * requires (id, mimeType, size, digest), the digest's algorithm SHA-256; or honey's `{path}`, a file the stdio server
 * reads under its root. Members a type alone would state are not declared (a host taking the extension knows them, and
 * a model is not to see them): runtime/mcp/files.ts checks the values, 38 tokens a file argument spared. The emitter's
 * half of the extension: its keyword is named here and nowhere else in gen.
 */
import type { JsonSchema } from "./schema.ts"

const STRING = { type: "string" }

/** A file argument's schema: the extension's FileInput, or a path the server reads. */
export const FILE_SCHEMA: JsonSchema = {
	anyOf: [
		{
			type: "object",
			"x-mcp-file": {},
			properties: {
				digest: {
					type: "object",
					properties: { algorithm: { const: "sha-256" }, value: STRING },
					required: ["algorithm", "value"],
				},
			},
			required: ["id", "mimeType", "size", "digest"],
		},
		{
			type: "object",
			properties: { path: { type: "string", description: "A file under the server's file root" } },
			required: ["path"],
			additionalProperties: false,
		},
	],
}
