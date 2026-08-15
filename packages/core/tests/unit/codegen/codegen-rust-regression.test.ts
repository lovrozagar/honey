import { describe, expect, test } from "vitest"
import { generateRustSDK } from "../../../src/codegen-rust.ts"

/* Minimal spec with a query-param string enum — forces renderHoistedStringEnum
 * into the resource .rs body via emitOptsStruct → renderUseRust. */
const minimalSpecWithEnumOpts = {
	info: { title: "Test", version: "1.0.0" },
	openapi: "3.1.0",
	paths: {
		"/webhooks/deliveries": {
			get: {
				operationId: "webhooks.deliveries.list",
				parameters: [
					{
						in: "query",
						name: "status",
						required: false,
						schema: {
							enum: ["pending", "delivered", "failed"],
							type: "string",
						},
					},
				],
				responses: {
					"200": {
						content: {
							"application/json": {
								schema: { items: { type: "object" }, type: "array" },
							},
						},
						description: "OK",
					},
				},
			},
		},
	},
}

/* Same spec without enum opts — sufficient for Cargo.toml version tests. */
const minimalSpec = {
	info: { title: "Test", version: "1.0.0" },
	openapi: "3.1.0",
	paths: {
		"/ping": {
			get: {
				operationId: "ping.get",
				responses: {
					"200": { description: "OK" },
				},
			},
		},
	},
}

/* Spec with an op whose final segment is a Rust reserved keyword (`use`).
 * The resource struct method must be escaped as `r#use`, not bare `use`. */
const specWithKeywordMethod = {
	info: { title: "Test", version: "1.0.0" },
	openapi: "3.1.0",
	paths: {
		"/ping": {
			get: {
				operationId: "ping.get",
				responses: {
					"200": { description: "OK" },
				},
			},
		},
		"/table-templates/{template_id}/use": {
			post: {
				operationId: "tableTemplates.use",
				parameters: [
					{
						in: "path",
						name: "template_id",
						required: true,
						schema: { type: "string" },
					},
				],
				requestBody: {
					content: {
						"application/json": {
							schema: { type: "object" },
						},
					},
				},
				responses: {
					"201": { description: "Created" },
				},
			},
		},
	},
}

/* Spec whose opts struct has a REQUIRED enum field — triggers the Default/enum
 * mismatch. `format` is required so the struct field is not Option-wrapped,
 * meaning Default on the struct requires Default on the enum. */
const specWithRequiredEnumOpts = {
	info: { title: "Test", version: "1.0.0" },
	openapi: "3.1.0",
	paths: {
		"/exports": {
			get: {
				operationId: "exports.list",
				parameters: [
					{
						in: "query",
						name: "format",
						required: true,
						schema: {
							enum: ["csv", "json", "xlsx"],
							type: "string",
						},
					},
				],
				responses: {
					"200": { description: "OK" },
				},
			},
		},
	},
}

describe("Regression: serde trait imports in resource files", () => {
	test("resource files import Serialize and Deserialize traits, not bare serde", () => {
		const { files } = generateRustSDK(minimalSpecWithEnumOpts, { crateName: "test" })
		const resourceFiles = Object.entries(files).filter(
			([p]) => p.startsWith("src/resources/") && p.endsWith(".rs") && p !== "src/resources/mod.rs",
		)
		expect(resourceFiles.length).toBeGreaterThan(0)
		for (const [, body] of resourceFiles) {
			if (body.includes("#[derive(")) {
				expect(body).toContain("use serde::{Serialize, Deserialize};")
				expect(body).not.toMatch(/^use serde;$/m)
			}
		}
	})
})

describe("Regression: Cargo.toml version threading", () => {
	test("Cargo.toml version reflects options.version", () => {
		const { files } = generateRustSDK(minimalSpec, { crateName: "test", version: "1.0.0" })
		expect(files["Cargo.toml"]).toContain(`version = "1.0.0"`)
	})

	test("Cargo.toml version defaults to 0.1.0 when unset", () => {
		const { files } = generateRustSDK(minimalSpec, { crateName: "test" })
		expect(files["Cargo.toml"]).toContain(`version = "0.1.0"`)
	})
})

describe("Regression: reserved-word method names escaped with r# prefix", () => {
	/* Rust reserved keywords must never appear as bare fn names — use raw-identifier syntax. */
	const RESERVED_BARE_FN =
		/\bpub\s+(?:async\s+)?fn\s+(as|box|break|const|continue|crate|do|dyn|else|enum|extern|false|final|fn|for|if|impl|in|let|loop|match|mod|move|mut|override|priv|pub|ref|return|self|Self|static|struct|super|trait|true|try|type|typeof|union|unsafe|unsized|use|virtual|where|while|yield|abstract|async|await|become|macro)\b/

	test("no resource file emits a bare reserved keyword as a fn name", () => {
		const { files } = generateRustSDK(specWithKeywordMethod, { crateName: "test" })
		const resourceFiles = Object.entries(files).filter(
			([p]) => p.startsWith("src/resources/") && p.endsWith(".rs") && p !== "src/resources/mod.rs",
		)
		expect(resourceFiles.length).toBeGreaterThan(0)
		for (const [path, body] of resourceFiles) {
			const match = body.match(RESERVED_BARE_FN)
			expect(match, `${path} emits bare reserved keyword fn: "${match?.[0]}"`).toBeNull()
		}
	})

	test("op with id ending in 'use' emits fn r#use", () => {
		const { files } = generateRustSDK(specWithKeywordMethod, { crateName: "test" })
		const resourceFiles = Object.entries(files).filter(
			([p]) => p.startsWith("src/resources/") && p.endsWith(".rs") && p !== "src/resources/mod.rs",
		)
		const allBodies = resourceFiles.map(([, body]) => body).join("\n")
		expect(allBodies).toMatch(/\bpub\s+(?:async\s+)?fn\s+r#use\b/)
	})
})

describe("Regression: opts struct Default derive consistent with enum fields", () => {
	/* An opts struct that derives Default must not contain a required enum field
	 * that has no Default impl — the Rust compiler rejects it. */
	test("required enum field in opts struct satisfies Default constraint", () => {
		const { files } = generateRustSDK(specWithRequiredEnumOpts, { crateName: "test" })
		const resourceFiles = Object.entries(files).filter(
			([p]) => p.startsWith("src/resources/") && p.endsWith(".rs") && p !== "src/resources/mod.rs",
		)
		expect(resourceFiles.length).toBeGreaterThan(0)

		for (const [path, body] of resourceFiles) {
			/* Find every opts struct that derives Default. */
			const optsStructPattern = /#\[derive\([^\]]*Default[^\]]*\)\]\s*pub struct (\w+Opts)\s*\{([^}]*)\}/gs
			for (const structMatch of body.matchAll(optsStructPattern)) {
				const structName = structMatch[1]
				const structBody = structMatch[2]

				/* Collect unqualified type names used as non-Option field types. */
				const fieldTypePattern = /^\s*pub \w+:\s*(?!Option<)(\w+),/gm
				for (const fieldMatch of structBody.matchAll(fieldTypePattern)) {
					const fieldType = fieldMatch[1]
					/* Skip primitives and standard library types. */
					if (/^(String|bool|i64|f64|u64|usize|i32|u32|f32)$/.test(fieldType)) continue
					if (fieldType.startsWith("std::") || fieldType.startsWith("serde_json")) continue

					/* The enum must satisfy Default via one of three valid approaches:
					 * 1. #[derive(...Default...)] with #[default] on a variant, OR
					 * 2. impl Default for <EnumName> block, OR
					 * 3. the opts struct does NOT derive Default (field is non-optional non-Default type). */
					const hasDefaultDerive = new RegExp(
						`#\\[derive\\([^\\]]*Default[^\\]]*\\)\\]\\s*pub enum ${fieldType}\\b`,
					).test(body)
					const hasImplDefault = new RegExp(`impl Default for ${fieldType}\\b`).test(body)

					const satisfiesDefault = hasDefaultDerive || hasImplDefault
					expect(
						satisfiesDefault,
						`${path}: struct ${structName} derives Default but field type ${fieldType} has no Default impl — compile error`,
					).toBe(true)
				}
			}
		}
	})
})
