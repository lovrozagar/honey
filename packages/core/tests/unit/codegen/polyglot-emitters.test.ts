/* Regression pins for the Go, Rust, Python and Go CLI emitter findings, on the adversarial
 * corpus. These run without toolchains; tests/integration/sdk-harness/polyglot-compile.test.ts
 * compiles the same output with go/cargo/python. */

import { describe, expect, it } from "vitest"
import { generateGoCLI } from "../../../src/codegen-go-cli.ts"
import { generateGoSDK } from "../../../src/codegen-go.ts"
import { deriveOperationId, toIR } from "../../../src/codegen-ir.ts"
import { goComment, goJsonTag, goString, pyDocLines, pyString, rustDoc, rustString } from "../../../src/codegen-lang.ts"
import { generatePythonSDK } from "../../../src/codegen-python.ts"
import { generateRustSDK } from "../../../src/codegen-rust.ts"
import { adversarialSpec } from "./__fixtures__/adversarial-spec.ts"

const spec = adversarialSpec as unknown as Record<string, unknown>
const go = generateGoSDK(spec).files
const goSafe = generateGoSDK(spec, { throwOnError: false }).files
const py = generatePythonSDK(spec).files
const rs = generateRustSDK(spec).files
const rsSafe = generateRustSDK(spec, { throwOnError: false }).files
const cli = generateGoCLI(spec, { binaryName: "adv" }).files
const all = (files: Record<string, string>) => Object.values(files).join("\n")

describe("literal and comment writers", () => {
	it("Go strings, comments and tags escape everything", () => {
		expect(goString('a"b\\c\nd\u0001')).toBe('"a\\"b\\\\c\\nd\\x01"')
		expect(goComment("one\ntwo */ three")).toEqual(["// one", "// two */ three"])
		expect(goJsonTag("a`b", false)).toBe('"json:\\"a`b\\""')
	})

	it("Rust strings use Rust escapes, not JSON's", () => {
		expect(rustString("\b\f\u0001")).toBe('"\\u{08}\\u{0c}\\u{01}"')
		expect(rustDoc("a\nb")).toEqual(["/// a", "/// b"])
	})

	it("Python strings and docstrings neutralize quotes and backslashes", () => {
		expect(pyString('a"\u2028')).toBe('"a\\"\\u2028"')
		expect(pyDocLines('C:\\users """end"')).toEqual(['C:\\\\users \\"\\"\\"end\\"'])
	})
})

describe("IR", () => {
	it("operations without operationId get a derived id for the non-TS emitters", () => {
		expect(deriveOperationId("delete", "/nothing/{id}")).toBe("deleteNothingById")
		expect(toIR(adversarialSpec as never).operations.some((o) => o.id === "deleteNothingById")).toBe(false)
		expect(go["client.go"]).toContain("func (c *Client) DeleteNothingById(")
		expect(py["client.py"]).toContain("async def delete_nothing_by_id(")
		expect(all(rs)).toContain("pub async fn delete_nothing_by_id(")
	})
})

describe("H41/H42 — SSE sends the operation's method, body, query and headers", () => {
	it("Go", () => {
		expect(go["client.go"]).toContain(
			'resp, err := openStream(ctx, r.client.cfg, "POST", path, q, jsonBody(body), callHeaders)',
		)
		expect(go["client.go"]).toContain('setHeaderValue(callHeaders, "x-tenant", opts.XTenant)')
	})
	it("Python", () => {
		expect(py["client.py"]).toMatch(/_open_stream\([^\n]*"POST", _url, _headers, json=body\)/)
	})
	it("Rust", () => {
		expect(rs["src/resources/events.rs"]).toMatch(
			/open_stream\(&client, &cfg, &auth, reqwest::Method::POST, &url_path, &query, crate::runtime::RequestBody::Json/,
		)
	})
	it("Go CLI", () => {
		expect(cli["cmd/events.go"]).toContain(
			'http.NewRequestWithContext(ctx, "POST", reqURL, bytes.NewReader(bodyBytes))',
		)
	})
})

describe("names", () => {
	it("H43 — Python keys that are not identifiers use the functional TypedDict syntax", () => {
		expect(py["types.py"]).toMatch(/User = TypedDict\(\n {4}"User",/)
		expect(py["types.py"]).toContain(`"content-type": "NotRequired[str]",`)
		expect(py["types.py"]).not.toMatch(/^\s+from: /m)
	})
	it("H44 — the sync SDK references only classes it emits", () => {
		const client = py["client.py"]
		for (const m of client.matchAll(/= (_Sync\w+)\(/g)) expect(client).toContain(`class ${m[1]}:`)
		expect(client).not.toContain("_SyncOnlyStreamsResource")
	})
	it("H45 — Python params never shadow the SDK's kwargs or locals", () => {
		expect(py["client.py"]).toContain(`"timeout": timeout2`)
		expect(py["client.py"]).toContain(`"headers": headers2`)
		expect(py["client.py"]).toContain(`"cancel_token": cancel_token2`)
	})
	it("H46 — Go receivers never collide with locals", () => {
		expect(go["client.go"]).toContain("func (r *QueueResource) List(")
		expect(go["client.go"]).not.toMatch(/func \(q \*/)
	})
	it("H47 — path params named like keywords or packages", () => {
		expect(go["client.go"]).toContain("Get(ctx context.Context, type_ string,")
		expect(go["client.go"]).toContain("Download(ctx context.Context, url_ string,")
		expect(rs["src/resources/type_.rs"]).toContain("pub async fn get(&self, type_: &str,")
	})
	it("H48 — multi-line descriptions stay comments", () => {
		expect(go["types.go"]).toContain("// Second line with */")
		expect(rs["src/types.rs"]).toContain("/// Second line with */")
		expect(go["doc.go"]).not.toMatch(/^Second line/m)
	})
	it("H49 — enum values become unique identifiers", () => {
		expect(go["types.go"]).toContain('StatusCreatedAt Status = "-created_at"')
		expect(go["types.go"]).toContain('StatusCreatedAt2 Status = "created_at"')
		expect(go["types.go"]).toContain('StatusEmpty Status = ""')
		expect(rs["src/types.rs"]).toMatch(/#\[serde\(rename = "self"\)\]\n\tSelf_?\w*,/)
	})
	it("H52 — schemas named like runtime or prelude types are renamed, not dropped", () => {
		expect(go["types.go"]).toContain("type ConfigModel struct")
		expect(go["client.go"]).toContain("(*ConfigModel, error)")
		expect(rs["src/types.rs"]).toContain("pub struct OptionModel")
		expect(rs["src/types.rs"]).toContain("pub struct ResultModel")
		expect(rs["src/types.rs"]).toContain("pub struct ErrorModel")
		expect(py["types.py"]).toContain("class NotFoundErrorModel(")
	})
	it("H53 — Rust sync resources exist for namespaces with only nested methods", () => {
		const teams = rs["src/resources/teams/mod.rs"]
		expect(teams).toContain("pub struct TeamsResourceSync {")
		expect(teams).toContain("pub members: TeamsMembersResourceSync,")
	})
	it("H54 — CLI flags never collide", () => {
		const queue = cli["cmd/queue.go"]
		expect(queue).toContain(`"query-timeout"`)
		expect(queue).toContain(`"query-output"`)
		expect(queue).toContain(`"query-config"`)
		expect(queue).toMatch(/"user-id"[\s\S]*"query-user-id"/)
		expect(cli["cmd/teams.go"]).toContain(`"body-data"`)
		expect(cli["cmd/teams.go"]).toContain(`"body-id"`)
	})
	it("CLI resource `root` does not overwrite cmd/root.go", () => {
		expect(cli["cmd/res_root.go"]).toContain(`Use:   "root"`)
		expect(cli["cmd/root.go"]).toContain("var rootCmd = &cobra.Command{")
	})
	it("CLI enum errors are literal (no format verbs)", () => {
		expect(cli["cmd/queue.go"]).toContain(
			'cli.Usage(errors.New("--order must be one of: 50%\\"off, -created_at, created_at"))',
		)
	})
	it("Rust hoisted names never merge (UserProfileSettings vs User.profile_settings)", () => {
		expect(rs["src/types.rs"]).toContain("pub struct UserProfileSettings ")
		expect(rs["src/types.rs"]).toContain("pub struct UserProfileSettings2 ")
	})
})

describe("types", () => {
	it("mutual recursion is boxed (Rust) / pointered (Go)", () => {
		expect(rs["src/types.rs"]).toContain("pub b: Option<Box<B>>,")
		expect(go["types.go"]).toContain("B *B")
	})
	it("discriminated unions keep the payload", () => {
		expect(go["types.go"]).toContain('case "cat":')
		expect(rs["src/types.rs"]).toContain("impl<'de> Deserialize<'de> for Pet {")
		expect(rs["src/types.rs"]).toContain('"cat" => serde_json::from_value(v).map(Pet::Cat)')
		expect(rs["src/types.rs"]).not.toContain("Variant(serde_json::Value)")
	})
	it("untagged const-string variants are reachable (Rust)", () => {
		expect(rs["src/types.rs"]).toContain("Literal(MixedLiteral),")
	})
	it("Go additionalProperties alongside fields round-trips through Extra", () => {
		expect(go["types.go"]).toContain("func (s *Extra) UnmarshalJSON(data []byte) error {")
		expect(go["types.go"]).toContain("base.Extra[k] = item")
	})
	it("Python aliases are typed, not NewType(Any)", () => {
		expect(py["types.py"]).toContain(`Tags: TypeAlias = "list[str]"`)
		expect(py["types.py"]).not.toContain("NewType(")
	})
})

describe("requests", () => {
	it("H50 — multipart and urlencoded bodies are sent (Go, Python)", () => {
		expect(go["client.go"]).toContain('parts = append(parts, fileField("data", body.Data))')
		expect(go["client.go"]).toContain("formBody(form)")
		expect(py["client.py"]).toContain("data=_data, files=_files")
		expect(py["client.py"]).toContain("content=_form_content(body)")
	})
	it("H51 — array, nullable and bracketed query params", () => {
		expect(go["client.go"]).toContain('q.set("ids", opts.Ids)')
		expect(go["client.go"]).toContain('q.set("page[size]", opts.PageSize)')
		expect(rs["src/resources/queue.rs"]).toContain('crate::runtime::push_serialized("ids", &opts.ids, &mut query);')
	})
	it("path params are validated in every SDK", () => {
		expect(go["client.go"]).toContain('expandPath("/users/{user-id}", map[string]string{"user-id": userId})')
		expect(py["client.py"]).toContain('_expand_path("/users/{user-id}", {"user-id": user_id})')
		expect(rs["src/resources/users.rs"]).toContain('expand_path("/users/{user-id}", &[("user-id", user_id)])?')
	})
	it("text and binary responses are not JSON-decoded", () => {
		expect(go["client.go"]).toContain("out = string(result.body)")
		expect(go["client.go"]).toContain("out = result.body")
		expect(rs["src/resources/forms.rs"]).toContain("String::from_utf8_lossy(&result.body)")
		expect(py["client.py"]).toContain('_parse_body(_response, "binary")')
	})
	it("realtime connections carry config headers and auth; Rust has a realtime branch", () => {
		expect(go["client.go"]).toContain("topts.Headers = authHeaders(")
		expect(py["client.py"]).toContain(
			"headers=_build_headers(self._client._config, extra=headers, bearer_token=self._client._auth.token),",
		)
		expect(rs["src/resources/rooms.rs"]).toContain("connect_with_defaults(url.to_string(), rt_opts)")
	})
	it("WebSocket dials send auth and config headers", () => {
		expect(go["client.go"]).toContain("HTTPHeader: authHeaders(r.client.cfg, callHeaders)")
		expect(rs["src/resources/rooms.rs"]).toContain(
			"crate::runtime::auth_headers(&self.client.cfg, &self.client.auth, None)",
		)
	})
	it("reads see and clear staleness in Go and Rust too", () => {
		const get = go["client.go"].slice(go["client.go"].indexOf("func (r *PetsResource) List("))
		expect(get.slice(0, 2000)).toContain('ClearStale(selector, path, "GET"')
		expect(rs["src/resources/pets.rs"]).toContain("stale.clear_stale(")
	})
	it("Rust safe mode populates SdkResult.error", () => {
		expect(all(rsSafe)).toContain(
			"return Ok(SdkResult { data: None, error: Some(Error::Api(api)), status, response });",
		)
		expect(goSafe["client.go"]).toContain("return SDKResult[")
	})
	it("output is deterministic", () => {
		expect(generateGoSDK(spec).files["client.go"]).toBe(go["client.go"])
		expect(generateRustSDK(spec).files["src/types.rs"]).toBe(rs["src/types.rs"])
		expect(generatePythonSDK(spec).files["types.py"]).toBe(py["types.py"])
	})
})
