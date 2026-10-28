/**
 * An Anyrow-shaped API (bit 21 c's acceptance): its five public multipart operations as its public document has them
 * (the extract once and as a stream, per project and per table, and suggest-schema), each `x-mcp` as Anyrow's codegen
 * marks them. Every request body is required, offered as multipart/form-data and as a urlencoded form, both one `$ref`
 * with no required part: `file` a binary (format and contentEncoding both binary) beside text parts. The streams answer
 * text/event-stream typed as a plain string. The credential is the `apiKey` scheme, a header `Authorization` whose
 * description gives the `ApiKey ` prefix, beside a `jwt` bearer scheme the public document keeps unrequired.
 */

const STRING = { type: "string" }
const FILE = { contentEncoding: "binary", format: "binary", type: "string" }
const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` })
const PROJECT = { in: "path", name: "project_id", required: true, schema: STRING }
const TABLE = { in: "path", name: "table_id", required: true, schema: STRING }

/** A request body of the form `name`, as both encodings. */
const form = (name: string) => ({
	content: { "application/x-www-form-urlencoded": { schema: ref(name) }, "multipart/form-data": { schema: ref(name) } },
	required: true,
})

/** A POST of `id` with `parameters` sending the form `body`, answering `answer`: JSON, or an event stream if `stream`. */
const post = (id: string, parameters: object[], [body, answer]: readonly [string, string], stream = false) => ({
	post: {
		operationId: id,
		parameters,
		requestBody: form(body),
		responses: {
			200: {
				content: { [stream ? "text/event-stream" : "application/json"]: { schema: ref(answer) } },
				description: "OK",
			},
		},
		security: [{ apiKey: ["extract:write"] }],
		"x-mcp": true,
	},
})

const EXTRACT_RESULT = {
	properties: {
		batch_id: STRING,
		confidence: { type: ["number", "null"] },
		credits: { type: "integer" },
		duration_ms: { type: ["integer", "null"] },
		fail_count: { type: "integer" },
		file_type: STRING,
		files: {
			items: {
				properties: {
					confidence: { type: "number" },
					error: STRING,
					file_name: STRING,
					rows: { type: "integer" },
					status: STRING,
				},
				type: "object",
			},
			type: "array",
		},
		result: { additionalProperties: {}, type: "object" },
		status: STRING,
		success_count: { type: "integer" },
		table_id: STRING,
		total_rows: { type: "integer" },
	},
	required: ["confidence", "credits", "duration_ms", "fail_count", "files", "status", "success_count", "table_id"],
	type: "object",
}

/** The public document's schemas the five operations reach, and its two security schemes. */
const components = () => ({
	schemas: {
		CreateProjectsExtractRequest: {
			properties: {
				columns: STRING,
				file: FILE,
				instruction: { maxLength: 1_000_000, type: "string" },
				schema: STRING,
				strictness: { enum: ["strict", "balanced", "flexible"], type: "string" },
				text: { maxLength: 1_000_000, type: "string" },
			},
			type: "object",
		},
		CreateProjectsExtractResponse200: EXTRACT_RESULT,
		CreateProjectsSuggestSchemaRequest: {
			properties: { file: FILE, text: { maxLength: 1_000_000, type: "string" } },
			type: "object",
		},
		CreateInternalAiSuggestSchemaResponse200: {
			properties: {
				columns: {
					items: {
						properties: { description: STRING, name: STRING, type: STRING },
						required: ["name", "type"],
						type: "object",
					},
					type: "array",
				},
				confidence: { type: "number" },
				instruction: STRING,
			},
			required: ["columns", "confidence"],
			type: "object",
		},
		ListProjectsBatchesDownloadCsvResponse200: STRING,
	},
	securitySchemes: {
		apiKey: {
			description: "API key authentication. Format: ApiKey {your_api_key}",
			in: "header",
			name: "Authorization",
			type: "apiKey",
		},
		jwt: { bearerFormat: "JWT", scheme: "bearer", type: "http" },
	},
})

/** Anyrow's public document, cut to the five multipart operations, every one marked x-mcp. */
export const anyrow = () => ({
	components: components(),
	info: { title: "Anyrow API", version: "1.0.0" },
	openapi: "3.1.0",
	paths: {
		"/v1/projects/{project_id}/extract": post(
			"extract.once",
			[PROJECT],
			["CreateProjectsExtractRequest", "CreateProjectsExtractResponse200"],
		),
		"/v1/projects/{project_id}/extract-stream": post(
			"extract.stream",
			[PROJECT],
			["CreateProjectsExtractRequest", "ListProjectsBatchesDownloadCsvResponse200"],
			true,
		),
		"/v1/projects/{project_id}/suggest-schema": post(
			"suggest.schema",
			[PROJECT],
			["CreateProjectsSuggestSchemaRequest", "CreateInternalAiSuggestSchemaResponse200"],
		),
		"/v1/projects/{project_id}/tables/{table_id}/extract": post(
			"extract.table.once",
			[PROJECT, TABLE],
			["CreateProjectsSuggestSchemaRequest", "CreateProjectsExtractResponse200"],
		),
		"/v1/projects/{project_id}/tables/{table_id}/extract-stream": post(
			"extract.table.stream",
			[PROJECT, TABLE],
			["CreateProjectsSuggestSchemaRequest", "ListProjectsBatchesDownloadCsvResponse200"],
			true,
		),
	},
	security: [{ apiKey: ["extract:write"] }],
	servers: [{ url: "/api" }],
})
