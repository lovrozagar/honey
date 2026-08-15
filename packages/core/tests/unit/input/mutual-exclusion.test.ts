import { describe, expectTypeOf, it } from "vitest";
import type { InputSchemaEntry, InputSchemasDef } from "../../../src/types.ts";

describe("InputSchemasDef mutual exclusion", () => {
	it("json alone compiles", () => {
		const def: InputSchemasDef = { json: {} as InputSchemaEntry };
		expectTypeOf(def).toMatchTypeOf<InputSchemasDef>();
	});

	it("form alone compiles", () => {
		const def: InputSchemasDef = { form: {} as InputSchemaEntry };
		expectTypeOf(def).toMatchTypeOf<InputSchemasDef>();
	});

	it("json + non-body sources compiles", () => {
		const def: InputSchemasDef = {
			cookies: {} as InputSchemaEntry,
			headers: {} as InputSchemaEntry,
			json: {} as InputSchemaEntry,
			params: {} as InputSchemaEntry,
			search: {} as InputSchemaEntry,
		};
		expectTypeOf(def).toMatchTypeOf<InputSchemasDef>();
	});

	it("form + non-body sources compiles", () => {
		const def: InputSchemasDef = {
			cookies: {} as InputSchemaEntry,
			form: {} as InputSchemaEntry,
			headers: {} as InputSchemaEntry,
			params: {} as InputSchemaEntry,
			search: {} as InputSchemaEntry,
		};
		expectTypeOf(def).toMatchTypeOf<InputSchemasDef>();
	});

	it("non-body only compiles", () => {
		const def: InputSchemasDef = {
			params: {} as InputSchemaEntry,
			search: {} as InputSchemaEntry,
		};
		expectTypeOf(def).toMatchTypeOf<InputSchemasDef>();
	});

	it("empty compiles", () => {
		const def: InputSchemasDef = {};
		expectTypeOf(def).toMatchTypeOf<InputSchemasDef>();
	});

	it("json + form does NOT compile", () => {
		/* @ts-expect-error json and form are mutually exclusive */
		const _bad: InputSchemasDef = {
			form: {} as InputSchemaEntry,
			json: {} as InputSchemaEntry,
		};
		void _bad;
	});
});
