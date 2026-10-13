/* Runs the generated Go and Rust types: absent, null and a value round-trip as three states, and
 * a required list or map left empty is sent as [] / {}, never null. */
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { describe, expect, it } from "vitest"
import { generateGoSDK } from "../../../src/codegen-go.ts"
import { generateRustSDK } from "../../../src/codegen-rust.ts"
import { CARGO_TARGET_DIR } from "../../cargo-env.ts"
import { triStateSpec } from "../../fixtures/tri-state-spec.ts"

function has(cmd: string, args: string[]): boolean {
	return spawnSync(cmd, args, { stdio: "ignore" }).status === 0
}

function writeTree(root: string, files: Record<string, string>): void {
	for (const [rel, content] of Object.entries(files)) {
		const p = join(root, rel)
		mkdirSync(dirname(p), { recursive: true })
		writeFileSync(p, content, "utf8")
	}
}

function run(cmd: string, args: string[], cwd: string, env: NodeJS.ProcessEnv = process.env) {
	const r = spawnSync(cmd, args, { cwd, encoding: "utf8", env, timeout: 600_000 })
	return { err: `${r.stdout ?? ""}${r.stderr ?? ""}`, ok: r.status === 0 }
}

const GO_TEST = `package sdk

import (
	"encoding/json"
	"testing"
)

func TestTriState(t *testing.T) {
	b, _ := json.Marshal(Thing{})
	if string(b) != \`{"attrs":{},"tags":[]}\` {
		t.Fatalf("zero value: %s", b)
	}
	b, _ = json.Marshal(Thing{Note: NullOf[string](), XKey: Some[int64](3)})
	if string(b) != \`{"attrs":{},"note":null,"tags":[],"x-key":3}\` {
		t.Fatalf("null and value: %s", b)
	}
	var th Thing
	if err := json.Unmarshal([]byte(\`{"note":null,"parent":{"tags":[],"attrs":{}}}\`), &th); err != nil {
		t.Fatal(err)
	}
	if !th.Note.IsNull() || !th.XKey.IsZero() {
		t.Fatalf("decode: %+v", th)
	}
	if p, ok := th.Parent.Get(); !ok || p == nil {
		t.Fatalf("parent: %+v", th.Parent)
	}
}
`

const RUST_TEST = `use tri_sdk::types::Thing;

#[test]
fn tri_state() {
    let t: Thing = serde_json::from_str(r#"{"tags":[],"attrs":{},"note":null}"#).unwrap();
    assert_eq!(t.note, Some(None));
    assert_eq!(t.x_key, None);
    let mut out = t.clone();
    out.x_key = Some(Some(3));
    let s = serde_json::to_string(&out).unwrap();
    assert!(s.contains(r#""note":null"#), "{s}");
    assert!(s.contains(r#""x-key":3"#), "{s}");
    out.note = None;
    let s = serde_json::to_string(&out).unwrap();
    assert!(!s.contains("note"), "{s}");
}
`

describe("optional + nullable fields at runtime", () => {
	it.skipIf(!has("go", ["version"]))(
		"Go",
		(ctx) => {
			const dir = mkdtempSync(join(tmpdir(), "honey-tri-go-"))
			try {
				writeTree(dir, generateGoSDK(triStateSpec, { modulePath: "example.com/tri" }).files)
				writeFileSync(join(dir, "tri_state_test.go"), GO_TEST)
				const r = run("go", ["test", "./..."], dir, { ...process.env, GOFLAGS: "-mod=mod" })
				if (!r.ok && /dial tcp|proxy\.golang|lookup /.test(r.err)) ctx.skip()
				expect(r.ok, r.err).toBe(true)
			} finally {
				rmSync(dir, { force: true, recursive: true })
			}
		},
		600_000,
	)

	it.skipIf(!has("cargo", ["--version"]))(
		"Rust",
		(ctx) => {
			const dir = mkdtempSync(join(tmpdir(), "honey-tri-rust-"))
			try {
				writeTree(dir, generateRustSDK(triStateSpec, { crateName: "tri-sdk" }).files)
				writeTree(dir, { "tests/tri_state.rs": RUST_TEST })
				const r = run("cargo", ["test", "--quiet", "--test", "tri_state"], dir, { ...process.env, CARGO_TARGET_DIR })
				if (!r.ok && /failed to download|Could not resolve/.test(r.err) && !/error\[E\d+\]/.test(r.err)) ctx.skip()
				expect(r.ok, r.err).toBe(true)
			} finally {
				rmSync(dir, { force: true, recursive: true })
			}
		},
		600_000,
	)
})
