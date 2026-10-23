/**
 * The `<ErrorKey>Data` both-ways leg (bit 16 phase f, item 2; owed since c1's B3 ruling): a component named exactly
 * `ItemLockedData` beside the error key `item.locked`, whose inline data schema the emitter hoists as `<Key>Data`. In
 * either declaration order (components before paths, or after), the component keeps `ItemLockedData` with its own
 * fields and the key's data claims `ItemLockedData2` with the key's; javac `-Werror` is clean, and a consumer program
 * binds each class to its own body: an operation's answer to the component, an error envelope's data to the hoist.
 */
import { describe, expect, it } from "vitest"
import { errors } from "../shared/__fixtures__/documents-http.ts"
import { type Reply, served } from "../shared/__fixtures__/recording-server.ts"
import { compiledJavaSdk } from "./__fixtures__/compiled.ts"
import { withJava } from "./__fixtures__/java-env.ts"
import { generateJavaSdk } from "./sdk.ts"

type Json = Record<string, unknown>

/** Whether Java is pinned here: a missing toolchain fails where it is required and skips these legs elsewhere. */
const JAVA = withJava()
/** A cold gate compiles the SDK first. */
const SLOW = { timeout: 600_000 }

const STRING = { type: "string" }
/** The component named like the hoist: its own field, `owner`, answered by `locks.get`. */
const COMPONENT = { properties: { owner: STRING }, required: ["owner"], type: "object" }
const LOCKS_GET = {
	get: {
		operationId: "locks.get",
		responses: {
			200: {
				content: { "application/json": { schema: { $ref: "#/components/schemas/ItemLockedData" } } },
				description: "ok",
			},
		},
	},
}

/** The `errors` document with `ItemLockedData` and `locks.get`, its components declared before or after its paths. */
function document(componentsFirst: boolean): Json {
	const base = errors() as Json & { components: { schemas: Json }; paths: Json }
	const components = { ...base.components, schemas: { ...base.components.schemas, ItemLockedData: COMPONENT } }
	const paths = { ...base.paths, "/locks": LOCKS_GET }
	const { info, openapi } = base
	return componentsFirst ? { components, info, openapi, paths } : { info, openapi, paths, components }
}

/** The record a file declares, as `name(components)`. */
const recordOf = (files: Readonly<Record<string, string>>, name: string) => {
	const text = files[`src/main/java/ai/anyrow/${name}.java`] ?? ""
	const match = /public record (\w+)\(([^{]*)\)\s*\{/.exec(text.replace(/@\w+(?:\.\w+)*(?:\([^)]*\))?\s*/g, ""))
	return match === null ? null : `${match[1]}(${match[2]?.replace(/\s+/g, " ").trim()})`
}

/** The consumer: the component through `locks.get`, the key's data through the 423's `decodeBody`. */
const PROBE = (url: string) => `package probe;

import ai.anyrow.*;

public final class Probe {
  public static void main(String[] args) {
    AnyrowClient client = AnyrowClient.builder().baseUrl("${url}").build();
    ItemLockedData lock = client.locks().get(LocksGetParams.builder().build());
    System.out.println(lock.getClass().getSimpleName() + " " + lock.owner());
    try {
      client.items().get(ItemsGetParams.builder().id("i3").build());
    } catch (ApiException e) {
      ItemLockedData2 data = e.decodeBody(ItemLockedData2.class);
      System.out.println(data.getClass().getSimpleName() + " " + data.until());
    }
  }
}
`
const REPLIES: readonly Reply[] = [
	{ json: { owner: "ada" }, status: 200 },
	{ json: { error_key: "item.locked", until: "noon" }, status: 423 },
]

describe("generateJavaSdk: a component named like a key's <Key>Data (item 2, B3)", () => {
	/* new: the c1 B3 ruling's both-ways leg; the claim order makes the hoist yield */
	it.each([true, false])(
		"keeps ItemLockedData the component's and hoists the key's as ItemLockedData2 (components first: %s)",
		(first) => {
			const files = generateJavaSdk(document(first)).files
			expect({
				component: recordOf(files, "ItemLockedData"),
				hoist: recordOf(files, "ItemLockedData2"),
				stale: Object.values(files).filter((text) => /\bItemLockedData3\b/.test(text)).length,
			}).toEqual({
				component: "ItemLockedData(String owner)",
				hoist: "ItemLockedData2(String until)",
				stale: 0,
			})
		},
	)
})

describe.skipIf(!JAVA)("a component named like a key's <Key>Data, compiled and bound (item 2, B3)", SLOW, () => {
	/* new: the reviewer's ruling: the exact class each way, through a consumer, not javac alone */
	it.each([true, false])(
		"compiles -Werror and binds the answer to ItemLockedData and the envelope's data to ItemLockedData2 (components first: %s)",
		async (first) => {
			const sdk = compiledJavaSdk(generateJavaSdk(document(first)).files)
			const ran = await served(REPLIES, (server) => sdk.exec("probe.Probe", PROBE(server.url)))
			expect({ diagnostics: sdk.javac.diagnostics, out: ran.stdout.trim().split("\n") }, ran.stderr).toEqual({
				diagnostics: [],
				out: ["ItemLockedData ada", "ItemLockedData2 noon"],
			})
		},
	)
})
