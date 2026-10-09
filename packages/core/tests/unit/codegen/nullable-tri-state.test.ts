/* An optional nullable field is tri-state in every SDK: absent, explicit null, or a value. */
import { describe, expect, it } from "vitest"
import { generateGoSDK } from "../../../src/codegen-go.ts"
import { generatePythonSDK } from "../../../src/codegen-python.ts"
import { generateRustSDK } from "../../../src/codegen-rust.ts"
import { triStateSpec } from "../../fixtures/tri-state-spec.ts"

describe("optional + nullable fields", () => {
	it("Go: Nullable[T] under omitzero; required slices and maps never encode as null", () => {
		const files = generateGoSDK(triStateSpec).files
		expect(files["nullable.go"]).toContain("type Nullable[T any] struct")
		expect(files["go.mod"]).toContain("go 1.24")
		const types = files["types.go"]
		expect(types).toContain('Note Nullable[string] `json:"note,omitzero"`')
		/* a cyclic ref stays a pointer inside Nullable */
		expect(types).toContain('Parent Nullable[*Thing] `json:"parent,omitzero"`')
		expect(types).toContain('Plain *string `json:"plain,omitempty"`')
		expect(types).toContain("p.Tags = []string{}")
		expect(types).toContain("p.Attrs = map[string]string{}")
	})

	it("Rust: Option<Option<T>> with a null-preserving deserializer", () => {
		const files = generateRustSDK(triStateSpec).files
		expect(files["src/nullable.rs"]).toContain("pub fn deserialize")
		expect(files["src/lib.rs"]).toContain("pub mod nullable;")
		const types = files["src/types.rs"]
		expect(types).toContain("pub note: Option<Option<String>>,")
		expect(types).toContain('deserialize_with = "crate::nullable::deserialize"')
		expect(types).toContain("pub plain: Option<String>,")
	})

	it("Python: NotRequired[T | None] — a missing key and None differ, and httpx sends None as null", () => {
		const types = generatePythonSDK(triStateSpec).files["types.py"]
		expect(types).toContain('"note": "NotRequired[str | None]"')
	})
})
