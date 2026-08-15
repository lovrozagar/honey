import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { execSync } from "node:child_process"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { generateRustSDK } from "../../../src/codegen-rust.ts"
import { hasBinary, loadMockSpec, startMockServerSubprocess } from "./harness-util.ts"

const hasCargo = hasBinary("cargo")
const hasIntegrationFlag = process.env["HONEY_RUST_INTEGRATION"] !== "0"

describe.skipIf(!hasCargo || !hasIntegrationFlag)("Rust SDK integration harness", () => {
	it("round-trip: createUser + getUser", async () => {
		const spec = loadMockSpec()
		const { files } = generateRustSDK(spec, { crateName: "mock-sdk" })
		const dir = mkdtempSync(join(tmpdir(), "honey-rust-harness-"))
		const { kill, port } = await startMockServerSubprocess()
		try {
			const sdkDir = join(dir, "mock-sdk")
			for (const [filename, content] of Object.entries(files)) {
				const dest = join(sdkDir, filename)
				mkdirSync(join(dest, ".."), { recursive: true })
				writeFileSync(dest, content, "utf8")
			}

			const runnerDir = join(dir, "runner")
			mkdirSync(join(runnerDir, "src"), { recursive: true })

			const runnerCargoToml = `[package]
name = "runner"
version = "0.1.0"
edition = "2021"

[dependencies]
mock-sdk = { path = "../mock-sdk" }
serde_json = "1"
tokio = { version = "1", features = ["full"] }
`
			writeFileSync(join(runnerDir, "Cargo.toml"), runnerCargoToml, "utf8")

			const mainRs = `use mock_sdk::Client;
use mock_sdk::ClientConfig;
use mock_sdk::types::UserCreate;
use mock_sdk::client::{CreateUserOpts, GetUserOpts};
use std::env;

#[tokio::main]
async fn main() {
    let base_url = env::var("BASE_URL").unwrap();
    let client = Client::new(ClientConfig {
        base_url,
        bearer_token: Some("valid-token".to_string()),
        ..Default::default()
    });
    let created = client.create_user(
        &UserCreate { name: "Alice".to_string(), email: "a@b.com".to_string() },
        &CreateUserOpts::default(),
    ).await.unwrap();
    let fetched = client.get_user(
        &created.id,
        &GetUserOpts::default(),
    ).await.unwrap();
    println!("{}", serde_json::json!({"created": created, "fetched": fetched}));
}
`
			writeFileSync(join(runnerDir, "src", "main.rs"), mainRs, "utf8")

			let stdout: string
			try {
				stdout = execSync("cargo run", {
					cwd: runnerDir,
					encoding: "utf8",
					env: { ...process.env, BASE_URL: `http://127.0.0.1:${port}` },
					timeout: 120_000,
				})
			} catch (err: unknown) {
				const e = err as { stderr?: string; stdout?: string; message?: string }
				throw new Error(
					`cargo run failed:\nstderr: ${e.stderr ?? ""}\nstdout: ${e.stdout ?? ""}\n${e.message ?? ""}`,
					{ cause: err },
				)
			}

			const result = JSON.parse(stdout.trim()) as { created: { name: string; id: string }; fetched: { id: string } }
			expect(result.created.name).toBe("Alice")
			expect(result.fetched.id).toBe(result.created.id)
		} finally {
			kill()
			rmSync(dir, { force: true, recursive: true })
		}
	}, 120_000)

	it("Test N — typed error data: 400 parses into typed Data field", async () => {
		const spec = loadMockSpec()
		const { files } = generateRustSDK(spec, { crateName: "mock-sdk" })
		const dir = mkdtempSync(join(tmpdir(), "honey-rust-harness-n-"))
		const { kill, port } = await startMockServerSubprocess()
		try {
			const sdkDir = join(dir, "mock-sdk")
			for (const [filename, content] of Object.entries(files)) {
				const dest = join(sdkDir, filename)
				mkdirSync(join(dest, ".."), { recursive: true })
				writeFileSync(dest, content, "utf8")
			}

			const runnerDir = join(dir, "runner")
			mkdirSync(join(runnerDir, "src"), { recursive: true })

			const runnerCargoToml = `[package]
name = "runner"
version = "0.1.0"
edition = "2021"

[dependencies]
mock-sdk = { path = "../mock-sdk" }
serde_json = "1"
tokio = { version = "1", features = ["full"] }
`
			writeFileSync(join(runnerDir, "Cargo.toml"), runnerCargoToml, "utf8")

			/* Compile-time RED gate: `bre.data` field access fails to build today
			 * because BadRequestError has no `data` field in errors.rs. */
			const mainRs = `use mock_sdk::Client;
use mock_sdk::ClientConfig;
use mock_sdk::client::GetDeclaredErrorOpts;
use mock_sdk::errors::{BadRequestError, Error};
use serde_json::Value;
use std::env;

#[tokio::main]
async fn main() {
    let base_url = env::var("BASE_URL").unwrap();
    let client = Client::new(ClientConfig {
        base_url,
        ..Default::default()
    });
    let result = client.get_declared_error("400", &GetDeclaredErrorOpts::default()).await;
    let mut out = serde_json::json!({
        "threw": false,
        "isBadRequest": false,
        "status": 0,
        "hasDataField": false,
        "dataIsSome": false,
        "dataStatus": Value::Null,
        "dataMessage": Value::Null,
        "bodyLen": 0,
    });
    match result {
        Ok(_) => {}
        Err(e) => {
            out["threw"] = Value::Bool(true);
            if let Error::Api(api_err) = e {
                let err_dyn: &(dyn std::error::Error + 'static) = api_err.as_ref();
                if let Some(bre) = err_dyn.downcast_ref::<BadRequestError>() {
                    out["isBadRequest"] = Value::Bool(true);
                    out["status"] = serde_json::json!(bre.status_code);
                    out["bodyLen"] = serde_json::json!(bre.body.len());
                    /* The next line is the RED gate: \`data\` field does not exist on
                     * BadRequestError yet. Compile fails until codegen+runtime add it. */
                    let data: &Option<Value> = &bre.data;
                    out["hasDataField"] = Value::Bool(true);
                    if let Some(d) = data.as_ref() {
                        out["dataIsSome"] = Value::Bool(true);
                        let s_opt: Option<&Value> = d.get("status");
                        if let Some(s) = s_opt {
                            out["dataStatus"] = s.clone();
                        }
                        let m_opt: Option<&Value> = d.get("message");
                        if let Some(m) = m_opt {
                            out["dataMessage"] = m.clone();
                        }
                    }
                }
            }
        }
    }
    println!("{}", out);
}
`
			writeFileSync(join(runnerDir, "src", "main.rs"), mainRs, "utf8")

			let stdout: string
			try {
				stdout = execSync("cargo run", {
					cwd: runnerDir,
					encoding: "utf8",
					env: { ...process.env, BASE_URL: `http://127.0.0.1:${port}` },
					timeout: 180_000,
				})
			} catch (err: unknown) {
				const e = err as { stderr?: string; stdout?: string; message?: string }
				throw new Error(
					`cargo run failed:\nstderr: ${e.stderr ?? ""}\nstdout: ${e.stdout ?? ""}\n${e.message ?? ""}`,
					{ cause: err },
				)
			}

			const result = JSON.parse(stdout.trim()) as {
				threw: boolean
				isBadRequest: boolean
				status: number
				hasDataField: boolean
				dataIsSome: boolean
				dataStatus: unknown
				dataMessage: unknown
				bodyLen: number
			}
			expect(result.threw).toBe(true)
			expect(result.isBadRequest).toBe(true)
			expect(result.status).toBe(400)
			expect(result.bodyLen).toBeGreaterThan(0)
			expect(result.hasDataField).toBe(true)
			expect(result.dataIsSome).toBe(true)
			expect(result.dataStatus).toBe(400)
			expect(result.dataMessage).toBe("Bad Request")
		} finally {
			kill()
			rmSync(dir, { force: true, recursive: true })
		}
	}, 180_000)

	it("Test Q (sync) — pre-cancelled Arc<AtomicBool> returns Err(Canceled) immediately", async () => {
		const spec = loadMockSpec()
		const { files } = generateRustSDK(spec, { crateName: "mock-sdk" })
		const dir = mkdtempSync(join(tmpdir(), "honey-rust-harness-q-"))
		const { kill, port } = await startMockServerSubprocess()
		try {
			const sdkDir = join(dir, "mock-sdk")
			for (const [filename, content] of Object.entries(files)) {
				const dest = join(sdkDir, filename)
				mkdirSync(join(dest, ".."), { recursive: true })
				writeFileSync(dest, content, "utf8")
			}

			const runnerDir = join(dir, "runner")
			mkdirSync(join(runnerDir, "src"), { recursive: true })

			const runnerCargoToml = `[package]
name = "runner"
version = "0.1.0"
edition = "2021"

[dependencies]
mock-sdk = { path = "../mock-sdk" }
serde_json = "1"
tokio = { version = "1", features = ["full"] }
`
			writeFileSync(join(runnerDir, "Cargo.toml"), runnerCargoToml, "utf8")

			const mainRs = `use mock_sdk::SyncClient;
use mock_sdk::SyncClientConfig;
use mock_sdk::client::GetUserOpts;
use mock_sdk::errors::Error;
use serde_json::Value;
use std::env;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

fn main() {
    let base_url = env::var("BASE_URL").unwrap();
    let client = SyncClient::new(SyncClientConfig {
        base_url,
        bearer_token: Some("valid-token".to_string()),
        ..Default::default()
    });
    let token = Arc::new(AtomicBool::new(true));
    /* sanity: token loads true */
    let loaded = token.load(Ordering::Acquire);
    let result = client.get_user(
        "any-id",
        &GetUserOpts {
            sync_cancel_token: Some(Arc::clone(&token)),
            ..Default::default()
        },
    );
    let mut out = serde_json::json!({
        "tokenLoaded": loaded,
        "isErr": false,
        "isCanceled": false,
        "errMessage": Value::Null,
    });
    match result {
        Ok(_) => {}
        Err(e) => {
            out["isErr"] = Value::Bool(true);
            if matches!(e, Error::Canceled) {
                out["isCanceled"] = Value::Bool(true);
            }
            out["errMessage"] = Value::String(e.to_string());
        }
    }
    println!("{}", out);
}
`
			writeFileSync(join(runnerDir, "src", "main.rs"), mainRs, "utf8")

			let stdout: string
			try {
				stdout = execSync("cargo run", {
					cwd: runnerDir,
					encoding: "utf8",
					env: { ...process.env, BASE_URL: `http://127.0.0.1:${port}` },
					timeout: 180_000,
				})
			} catch (err: unknown) {
				const e = err as { stderr?: string; stdout?: string; message?: string }
				throw new Error(
					`cargo run failed:\nstderr: ${e.stderr ?? ""}\nstdout: ${e.stdout ?? ""}\n${e.message ?? ""}`,
					{ cause: err },
				)
			}

			const result = JSON.parse(stdout.trim()) as {
				tokenLoaded: boolean
				isErr: boolean
				isCanceled: boolean
				errMessage: string | null
			}
			expect(result.tokenLoaded).toBe(true)
			expect(result.isErr).toBe(true)
			expect(result.isCanceled).toBe(true)
		} finally {
			kill()
			rmSync(dir, { force: true, recursive: true })
		}
	}, 180_000)

	it("Test R (async) — pre-cancelled CancellationToken returns Err(Canceled) immediately", async () => {
		const spec = loadMockSpec()
		const { files } = generateRustSDK(spec, { crateName: "mock-sdk" })
		const dir = mkdtempSync(join(tmpdir(), "honey-rust-harness-r-"))
		const { kill, port } = await startMockServerSubprocess()
		try {
			const sdkDir = join(dir, "mock-sdk")
			for (const [filename, content] of Object.entries(files)) {
				const dest = join(sdkDir, filename)
				mkdirSync(join(dest, ".."), { recursive: true })
				writeFileSync(dest, content, "utf8")
			}

			const runnerDir = join(dir, "runner")
			mkdirSync(join(runnerDir, "src"), { recursive: true })

			const runnerCargoToml = `[package]
name = "runner"
version = "0.1.0"
edition = "2021"

[dependencies]
mock-sdk = { path = "../mock-sdk" }
serde_json = "1"
tokio = { version = "1", features = ["full"] }
tokio-util = { version = "0.7", features = ["rt"] }
`
			writeFileSync(join(runnerDir, "Cargo.toml"), runnerCargoToml, "utf8")

			const mainRs = `use mock_sdk::Client;
use mock_sdk::ClientConfig;
use mock_sdk::client::GetUserOpts;
use mock_sdk::errors::Error;
use serde_json::Value;
use std::env;
use tokio_util::sync::CancellationToken;

#[tokio::main]
async fn main() {
    let base_url = env::var("BASE_URL").unwrap();
    let client = Client::new(ClientConfig {
        base_url,
        bearer_token: Some("valid-token".to_string()),
        ..Default::default()
    });
    let token = CancellationToken::new();
    /* cancel BEFORE the request fires */
    token.cancel();
    let cancelled_flag = token.is_cancelled();
    let result = client.get_user(
        "any-id",
        &GetUserOpts {
            cancel_token: Some(token.clone()),
            ..Default::default()
        },
    ).await;
    let mut out = serde_json::json!({
        "preCancelled": cancelled_flag,
        "isErr": false,
        "isCanceled": false,
        "errMessage": Value::Null,
    });
    match result {
        Ok(_) => {}
        Err(e) => {
            out["isErr"] = Value::Bool(true);
            if matches!(e, Error::Canceled) {
                out["isCanceled"] = Value::Bool(true);
            }
            out["errMessage"] = Value::String(e.to_string());
        }
    }
    println!("{}", out);
}
`
			writeFileSync(join(runnerDir, "src", "main.rs"), mainRs, "utf8")

			let stdout: string
			try {
				stdout = execSync("cargo run", {
					cwd: runnerDir,
					encoding: "utf8",
					env: { ...process.env, BASE_URL: `http://127.0.0.1:${port}` },
					timeout: 180_000,
				})
			} catch (err: unknown) {
				const e = err as { stderr?: string; stdout?: string; message?: string }
				throw new Error(
					`cargo run failed:\nstderr: ${e.stderr ?? ""}\nstdout: ${e.stdout ?? ""}\n${e.message ?? ""}`,
					{ cause: err },
				)
			}

			const result = JSON.parse(stdout.trim()) as {
				preCancelled: boolean
				isErr: boolean
				isCanceled: boolean
				errMessage: string | null
			}
			expect(result.preCancelled).toBe(true)
			expect(result.isErr).toBe(true)
			expect(result.isCanceled).toBe(true)
		} finally {
			kill()
			rmSync(dir, { force: true, recursive: true })
		}
	}, 180_000)

	it("Test Z (async) — on_request hooks run in order (second overwrites first), on_response hooks capture status in order", async () => {
		const spec = loadMockSpec()
		const { files } = generateRustSDK(spec, { crateName: "mock-sdk" })
		const dir = mkdtempSync(join(tmpdir(), "honey-rust-harness-z-"))
		const { kill, port } = await startMockServerSubprocess()
		try {
			const sdkDir = join(dir, "mock-sdk")
			for (const [filename, content] of Object.entries(files)) {
				const dest = join(sdkDir, filename)
				mkdirSync(join(dest, ".."), { recursive: true })
				writeFileSync(dest, content, "utf8")
			}

			const runnerDir = join(dir, "runner")
			mkdirSync(join(runnerDir, "src"), { recursive: true })

			const runnerCargoToml = `[package]
name = "runner"
version = "0.1.0"
edition = "2021"

[dependencies]
mock-sdk = { path = "../mock-sdk" }
serde_json = "1"
tokio = { version = "1", features = ["full"] }
`
			writeFileSync(join(runnerDir, "Cargo.toml"), runnerCargoToml, "utf8")

			/* Two on_request hooks: Hook A sets Bearer wrong, Hook B overwrites with Bearer valid-token.
			 * Chain order is proven by server response: 200/201 only if Hook B ran AFTER Hook A.
			 * Two on_response hooks push markers into shared Arc<Mutex<Vec<String>>> to prove
			 * response-side chain order with real observed status. */
			const mainRs = `use mock_sdk::Client;
use mock_sdk::ClientConfig;
use mock_sdk::types::UserCreate;
use mock_sdk::client::CreateUserOpts;
use mock_sdk::runtime::{OnRequestHook, OnResponseHook};
use serde_json::Value;
use std::env;
use std::sync::Arc;
use tokio::sync::Mutex;

#[tokio::main]
async fn main() {
    let base_url = env::var("BASE_URL").unwrap();

    let recorded: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));

    let hook_a: OnRequestHook = Arc::new(|ctx| {
        Box::pin(async move {
            ctx.headers.insert("Authorization".to_string(), "Bearer wrong".to_string());
            Ok(())
        })
    });
    let hook_b: OnRequestHook = Arc::new(|ctx| {
        Box::pin(async move {
            ctx.headers.insert("Authorization".to_string(), "Bearer valid-token".to_string());
            Ok(())
        })
    });

    let rec1 = Arc::clone(&recorded);
    let rhook1: OnResponseHook = Arc::new(move |ctx| {
        let rec = Arc::clone(&rec1);
        let status = ctx.status;
        Box::pin(async move {
            rec.lock().await.push(format!("status:{}", status));
            Ok(())
        })
    });
    let rec2 = Arc::clone(&recorded);
    let rhook2: OnResponseHook = Arc::new(move |_ctx| {
        let rec = Arc::clone(&rec2);
        Box::pin(async move {
            rec.lock().await.push("r2".to_string());
            Ok(())
        })
    });

    let client = Client::new(ClientConfig {
        base_url,
        on_request: vec![hook_a, hook_b],
        on_response: vec![rhook1, rhook2],
        ..Default::default()
    });

    let result = client.create_user(
        &UserCreate { name: "Alice".to_string(), email: "a@b.com".to_string() },
        &CreateUserOpts::default(),
    ).await;

    let mut out = serde_json::json!({
        "ok": false,
        "createdId": Value::Null,
        "recorded": Value::Null,
    });
    match result {
        Ok(created) => {
            out["ok"] = Value::Bool(true);
            out["createdId"] = Value::String(created.id.clone());
        }
        Err(e) => {
            out["ok"] = Value::Bool(false);
            out["error"] = Value::String(e.to_string());
        }
    }
    let rec = recorded.lock().await.clone();
    out["recorded"] = serde_json::json!(rec);
    println!("{}", out);
}
`
			writeFileSync(join(runnerDir, "src", "main.rs"), mainRs, "utf8")

			let stdout: string
			try {
				stdout = execSync("cargo run", {
					cwd: runnerDir,
					encoding: "utf8",
					env: { ...process.env, BASE_URL: `http://127.0.0.1:${port}` },
					timeout: 180_000,
				})
			} catch (err: unknown) {
				const e = err as { stderr?: string; stdout?: string; message?: string }
				throw new Error(
					`cargo run failed:\nstderr: ${e.stderr ?? ""}\nstdout: ${e.stdout ?? ""}\n${e.message ?? ""}`,
					{ cause: err },
				)
			}

			const result = JSON.parse(stdout.trim()) as {
				ok: boolean
				createdId: string | null
				recorded: string[]
				error?: string
			}
			expect(result.ok).toBe(true)
			expect(typeof result.createdId).toBe("string")
			expect((result.createdId ?? "").length).toBeGreaterThan(0)
			expect(result.recorded).toEqual(["status:201", "r2"])
		} finally {
			kill()
			rmSync(dir, { force: true, recursive: true })
		}
	}, 180_000)

	it("Test L1 (async) — on_log request lifecycle", async () => {
		const spec = loadMockSpec()
		const { files } = generateRustSDK(spec, { crateName: "mock-sdk" })
		const dir = mkdtempSync(join(tmpdir(), "honey-rust-harness-l1-"))
		const { kill, port } = await startMockServerSubprocess()
		try {
			const sdkDir = join(dir, "mock-sdk")
			for (const [filename, content] of Object.entries(files)) {
				const dest = join(sdkDir, filename)
				mkdirSync(join(dest, ".."), { recursive: true })
				writeFileSync(dest, content, "utf8")
			}

			const runnerDir = join(dir, "runner")
			mkdirSync(join(runnerDir, "src"), { recursive: true })

			const runnerCargoToml = `[package]
name = "runner"
version = "0.1.0"
edition = "2021"

[dependencies]
mock-sdk = { path = "../mock-sdk" }
serde_json = "1"
tokio = { version = "1", features = ["full"] }
`
			writeFileSync(join(runnerDir, "Cargo.toml"), runnerCargoToml, "utf8")

			const mainRs = `use mock_sdk::Client;
use mock_sdk::ClientConfig;
use mock_sdk::types::UserCreate;
use mock_sdk::client::CreateUserOpts;
use mock_sdk::runtime::{LogEntry, OnLogHook};
use serde_json::Value;
use std::env;
use std::sync::{Arc, Mutex};

#[tokio::main]
async fn main() {
    let base_url = env::var("BASE_URL").unwrap();

    let entries: Arc<Mutex<Vec<LogEntry>>> = Arc::new(Mutex::new(Vec::new()));
    let entries_for_hook = Arc::clone(&entries);
    let on_log: OnLogHook = Arc::new(move |e: LogEntry| {
        entries_for_hook.lock().unwrap().push(e);
    });

    let client = Client::new(ClientConfig {
        base_url,
        bearer_token: Some("valid-token".to_string()),
        on_log: Some(on_log),
        ..Default::default()
    });

    let _ = client.create_user(
        &UserCreate { name: "Log".to_string(), email: "l@l.com".to_string() },
        &CreateUserOpts::default(),
    ).await;

    let snapshot = entries.lock().unwrap().clone();
    let arr: Vec<Value> = snapshot.iter().map(|e| {
        serde_json::json!({
            "level": e.level,
            "event": e.event,
            "operation": e.operation,
            "duration_ms": e.duration_ms,
            "status": e.status,
        })
    }).collect();
    println!("{}", Value::Array(arr));
}
`
			writeFileSync(join(runnerDir, "src", "main.rs"), mainRs, "utf8")

			let stdout: string
			try {
				stdout = execSync("cargo run", {
					cwd: runnerDir,
					encoding: "utf8",
					env: { ...process.env, BASE_URL: `http://127.0.0.1:${port}` },
					timeout: 180_000,
				})
			} catch (err: unknown) {
				const e = err as { stderr?: string; stdout?: string; message?: string }
				throw new Error(
					`cargo run failed:\nstderr: ${e.stderr ?? ""}\nstdout: ${e.stdout ?? ""}\n${e.message ?? ""}`,
					{ cause: err },
				)
			}

			const result = JSON.parse(stdout.trim()) as Array<{
				level: string
				event: string
				operation: string
				duration_ms: number
				status: number | null
			}>
			expect(result.length).toBe(2)
			expect(result[0]?.event).toBe("request_start")
			expect(result[0]?.level).toBe("debug")
			expect(result[0]?.operation).toBe("POST /users")
			expect(result[0]?.duration_ms).toBe(0)
			expect(result[0]?.status).toBeNull()
			expect(result[1]?.event).toBe("response_received")
			expect(result[1]?.level).toBe("info")
			expect(result[1]?.operation).toBe("POST /users")
			expect(result[1]?.status).toBe(201)
			expect(result[1]?.duration_ms).toBeGreaterThanOrEqual(0)
			expect(Number.isFinite(result[1]?.duration_ms ?? Number.NaN)).toBe(true)
		} finally {
			kill()
			rmSync(dir, { force: true, recursive: true })
		}
	}, 180_000)

	it("Test L1 (sync) — on_log request lifecycle", async () => {
		const spec = loadMockSpec()
		const { files } = generateRustSDK(spec, { crateName: "mock-sdk" })
		const dir = mkdtempSync(join(tmpdir(), "honey-rust-harness-l1-sync-"))
		const { kill, port } = await startMockServerSubprocess()
		try {
			const sdkDir = join(dir, "mock-sdk")
			for (const [filename, content] of Object.entries(files)) {
				const dest = join(sdkDir, filename)
				mkdirSync(join(dest, ".."), { recursive: true })
				writeFileSync(dest, content, "utf8")
			}

			const runnerDir = join(dir, "runner")
			mkdirSync(join(runnerDir, "src"), { recursive: true })

			const runnerCargoToml = `[package]
name = "runner"
version = "0.1.0"
edition = "2021"

[dependencies]
mock-sdk = { path = "../mock-sdk" }
serde_json = "1"
`
			writeFileSync(join(runnerDir, "Cargo.toml"), runnerCargoToml, "utf8")

			const mainRs = `use mock_sdk::SyncClient;
use mock_sdk::SyncClientConfig;
use mock_sdk::types::UserCreate;
use mock_sdk::client::CreateUserOpts;
use mock_sdk::runtime::{LogEntry, OnLogHook};
use serde_json::Value;
use std::env;
use std::sync::{Arc, Mutex};

fn main() {
    let base_url = env::var("BASE_URL").unwrap();

    let entries: Arc<Mutex<Vec<LogEntry>>> = Arc::new(Mutex::new(Vec::new()));
    let entries_for_hook = Arc::clone(&entries);
    let on_log: OnLogHook = Arc::new(move |e: LogEntry| {
        entries_for_hook.lock().unwrap().push(e);
    });

    let client = SyncClient::new(SyncClientConfig {
        base_url,
        bearer_token: Some("valid-token".to_string()),
        on_log: Some(on_log),
        ..Default::default()
    });

    let _ = client.create_user(
        &UserCreate { name: "Log".to_string(), email: "l@l.com".to_string() },
        &CreateUserOpts::default(),
    );

    let snapshot = entries.lock().unwrap().clone();
    let arr: Vec<Value> = snapshot.iter().map(|e| {
        serde_json::json!({
            "level": e.level,
            "event": e.event,
            "operation": e.operation,
            "duration_ms": e.duration_ms,
            "status": e.status,
        })
    }).collect();
    println!("{}", Value::Array(arr));
}
`
			writeFileSync(join(runnerDir, "src", "main.rs"), mainRs, "utf8")

			let stdout: string
			try {
				stdout = execSync("cargo run", {
					cwd: runnerDir,
					encoding: "utf8",
					env: { ...process.env, BASE_URL: `http://127.0.0.1:${port}` },
					timeout: 180_000,
				})
			} catch (err: unknown) {
				const e = err as { stderr?: string; stdout?: string; message?: string }
				throw new Error(
					`cargo run failed:\nstderr: ${e.stderr ?? ""}\nstdout: ${e.stdout ?? ""}\n${e.message ?? ""}`,
					{ cause: err },
				)
			}

			const result = JSON.parse(stdout.trim()) as Array<{
				level: string
				event: string
				operation: string
				duration_ms: number
				status: number | null
			}>
			expect(result.length).toBe(2)
			expect(result[0]?.event).toBe("request_start")
			expect(result[0]?.level).toBe("debug")
			expect(result[0]?.operation).toBe("POST /users")
			expect(result[0]?.duration_ms).toBe(0)
			expect(result[0]?.status).toBeNull()
			expect(result[1]?.event).toBe("response_received")
			expect(result[1]?.level).toBe("info")
			expect(result[1]?.operation).toBe("POST /users")
			expect(result[1]?.status).toBe(201)
			expect(result[1]?.duration_ms).toBeGreaterThanOrEqual(0)
			expect(Number.isFinite(result[1]?.duration_ms ?? Number.NaN)).toBe(true)
		} finally {
			kill()
			rmSync(dir, { force: true, recursive: true })
		}
	}, 180_000)

	it("Test Z (sync) — sync on_request hooks run in order, sync on_response hooks capture status in order", async () => {
		const spec = loadMockSpec()
		const { files } = generateRustSDK(spec, { crateName: "mock-sdk" })
		const dir = mkdtempSync(join(tmpdir(), "honey-rust-harness-z-sync-"))
		const { kill, port } = await startMockServerSubprocess()
		try {
			const sdkDir = join(dir, "mock-sdk")
			for (const [filename, content] of Object.entries(files)) {
				const dest = join(sdkDir, filename)
				mkdirSync(join(dest, ".."), { recursive: true })
				writeFileSync(dest, content, "utf8")
			}

			const runnerDir = join(dir, "runner")
			mkdirSync(join(runnerDir, "src"), { recursive: true })

			const runnerCargoToml = `[package]
name = "runner"
version = "0.1.0"
edition = "2021"

[dependencies]
mock-sdk = { path = "../mock-sdk" }
serde_json = "1"
`
			writeFileSync(join(runnerDir, "Cargo.toml"), runnerCargoToml, "utf8")

			const mainRs = `use mock_sdk::SyncClient;
use mock_sdk::SyncClientConfig;
use mock_sdk::types::UserCreate;
use mock_sdk::client::CreateUserOpts;
use mock_sdk::runtime_sync::{SyncOnRequestHook, SyncOnResponseHook};
use serde_json::Value;
use std::env;
use std::sync::{Arc, Mutex};

fn main() {
    let base_url = env::var("BASE_URL").unwrap();

    let recorded: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));

    let hook_a: SyncOnRequestHook = Arc::new(|ctx| {
        ctx.headers.insert("Authorization".to_string(), "Bearer wrong".to_string());
        Ok(())
    });
    let hook_b: SyncOnRequestHook = Arc::new(|ctx| {
        ctx.headers.insert("Authorization".to_string(), "Bearer valid-token".to_string());
        Ok(())
    });

    let rec1 = Arc::clone(&recorded);
    let rhook1: SyncOnResponseHook = Arc::new(move |ctx| {
        rec1.lock().unwrap().push(format!("status:{}", ctx.status));
        Ok(())
    });
    let rec2 = Arc::clone(&recorded);
    let rhook2: SyncOnResponseHook = Arc::new(move |_ctx| {
        rec2.lock().unwrap().push("r2".to_string());
        Ok(())
    });

    let client = SyncClient::new(SyncClientConfig {
        base_url,
        on_request: vec![hook_a, hook_b],
        on_response: vec![rhook1, rhook2],
        ..Default::default()
    });

    let result = client.create_user(
        &UserCreate { name: "Alice".to_string(), email: "a@b.com".to_string() },
        &CreateUserOpts::default(),
    );

    let mut out = serde_json::json!({
        "ok": false,
        "createdId": Value::Null,
        "recorded": Value::Null,
    });
    match result {
        Ok(created) => {
            out["ok"] = Value::Bool(true);
            out["createdId"] = Value::String(created.id.clone());
        }
        Err(e) => {
            out["ok"] = Value::Bool(false);
            out["error"] = Value::String(e.to_string());
        }
    }
    let rec = recorded.lock().unwrap().clone();
    out["recorded"] = serde_json::json!(rec);
    println!("{}", out);
}
`
			writeFileSync(join(runnerDir, "src", "main.rs"), mainRs, "utf8")

			let stdout: string
			try {
				stdout = execSync("cargo run", {
					cwd: runnerDir,
					encoding: "utf8",
					env: { ...process.env, BASE_URL: `http://127.0.0.1:${port}` },
					timeout: 180_000,
				})
			} catch (err: unknown) {
				const e = err as { stderr?: string; stdout?: string; message?: string }
				throw new Error(
					`cargo run failed:\nstderr: ${e.stderr ?? ""}\nstdout: ${e.stdout ?? ""}\n${e.message ?? ""}`,
					{ cause: err },
				)
			}

			const result = JSON.parse(stdout.trim()) as {
				ok: boolean
				createdId: string | null
				recorded: string[]
				error?: string
			}
			expect(result.ok).toBe(true)
			expect(typeof result.createdId).toBe("string")
			expect((result.createdId ?? "").length).toBeGreaterThan(0)
			expect(result.recorded).toEqual(["status:201", "r2"])
		} finally {
			kill()
			rmSync(dir, { force: true, recursive: true })
		}
	}, 180_000)

	it("Test Z (invalidation) — mutating ops mark exact + templated targets stale, is_stale walks both tiers", async () => {
		const spec = loadMockSpec()
		const { files } = generateRustSDK(spec, { crateName: "mock-sdk" })
		const dir = mkdtempSync(join(tmpdir(), "honey-rust-harness-z-invalidation-"))
		const { kill, port } = await startMockServerSubprocess()
		try {
			const sdkDir = join(dir, "mock-sdk")
			for (const [filename, content] of Object.entries(files)) {
				const dest = join(sdkDir, filename)
				mkdirSync(join(dest, ".."), { recursive: true })
				writeFileSync(dest, content, "utf8")
			}

			const runnerDir = join(dir, "runner")
			mkdirSync(join(runnerDir, "src"), { recursive: true })

			const runnerCargoToml = `[package]
name = "runner"
version = "0.1.0"
edition = "2021"

[dependencies]
mock-sdk = { path = "../mock-sdk" }
serde_json = "1"
tokio = { version = "1", features = ["full"] }
`
			writeFileSync(join(runnerDir, "Cargo.toml"), runnerCargoToml, "utf8")

			const mainRs = `use mock_sdk::Client;
use mock_sdk::ClientConfig;
use mock_sdk::runtime::InvalidationConfig;
use mock_sdk::types::{UserCreate, UserUpdate};
use mock_sdk::client::{CreateUserOpts, UpdateUserOpts};
use std::env;

#[tokio::main]
async fn main() {
    let base_url = env::var("BASE_URL").unwrap();
    let client = Client::new(ClientConfig {
        base_url,
        bearer_token: Some("valid-token".to_string()),
        invalidation: Some(InvalidationConfig {
            stale_time: 5000,
            stale_max_entries: 100,
            max_sources_per_target: 16,
        }),
        ..Default::default()
    });

    let before_create_users = client.is_stale("GET", "/users").await;
    let before_create_users_u1 = client.is_stale("GET", "/users/u1").await;

    let created = client.create_user(
        &UserCreate { name: "Alice".to_string(), email: "a@b.com".to_string() },
        &CreateUserOpts::default(),
    ).await.unwrap();

    let after_create_users = client.is_stale("GET", "/users").await;
    let after_create_users_u1 = client.is_stale("GET", "/users/u1").await;

    let _updated = client.update_user(
        &created.id,
        &UserUpdate { name: Some("Bob".to_string()), email: None },
        &UpdateUserOpts::default(),
    ).await.unwrap();

    let after_update_users = client.is_stale("GET", "/users").await;
    let after_update_users_self = client.is_stale("GET", &format!("/users/{}", created.id)).await;
    let after_update_users_other = client.is_stale("GET", "/users/other").await;

    let out = serde_json::json!({
        "before_create_users": before_create_users,
        "before_create_users_u1": before_create_users_u1,
        "after_create_users": after_create_users,
        "after_create_users_u1": after_create_users_u1,
        "after_update_users": after_update_users,
        "after_update_users_self": after_update_users_self,
        "after_update_users_other": after_update_users_other,
    });
    println!("{}", out);
}
`
			writeFileSync(join(runnerDir, "src", "main.rs"), mainRs, "utf8")

			let stdout: string
			try {
				stdout = execSync("cargo run", {
					cwd: runnerDir,
					encoding: "utf8",
					env: { ...process.env, BASE_URL: `http://127.0.0.1:${port}` },
					timeout: 180_000,
				})
			} catch (err: unknown) {
				const e = err as { stderr?: string; stdout?: string; message?: string }
				throw new Error(
					`cargo run failed:\nstderr: ${e.stderr ?? ""}\nstdout: ${e.stdout ?? ""}\n${e.message ?? ""}`,
					{ cause: err },
				)
			}

			const result = JSON.parse(stdout.trim()) as {
				before_create_users: boolean
				before_create_users_u1: boolean
				after_create_users: boolean
				after_create_users_u1: boolean
				after_update_users: boolean
				after_update_users_self: boolean
				after_update_users_other: boolean
			}
			expect(result.before_create_users).toBe(false)
			expect(result.before_create_users_u1).toBe(false)
			expect(result.after_create_users).toBe(true)
			expect(result.after_create_users_u1).toBe(false)
			expect(result.after_update_users).toBe(true)
			expect(result.after_update_users_self).toBe(true)
			expect(result.after_update_users_other).toBe(false)
		} finally {
			kill()
			rmSync(dir, { force: true, recursive: true })
		}
	}, 240_000)

	it("Test 7.a.5 — streaming upload (impl Stream<Bytes>, 1MB) returns matching size + sha256", async () => {
		const spec = loadMockSpec()
		const { files } = generateRustSDK(spec, { crateName: "mock-sdk" })
		const dir = mkdtempSync(join(tmpdir(), "honey-rust-harness-upload-"))
		const { kill, port } = await startMockServerSubprocess()
		try {
			const sdkDir = join(dir, "mock-sdk")
			for (const [filename, content] of Object.entries(files)) {
				const dest = join(sdkDir, filename)
				mkdirSync(join(dest, ".."), { recursive: true })
				writeFileSync(dest, content, "utf8")
			}

			const runnerDir = join(dir, "runner")
			mkdirSync(join(runnerDir, "src"), { recursive: true })

			const runnerCargoToml = `[package]
name = "runner"
version = "0.1.0"
edition = "2021"

[dependencies]
mock-sdk = { path = "../mock-sdk" }
serde_json = "1"
tokio = { version = "1", features = ["full"] }
bytes = "1"
futures = "0.3"
reqwest = { version = "0.12", default-features = false, features = ["json", "stream", "rustls-tls"] }
sha2 = "0.10"
hex = "0.4"
`
			writeFileSync(join(runnerDir, "Cargo.toml"), runnerCargoToml, "utf8")

			/* RED gate: without codegen + runtime changes, `upload_blob` either doesn't
			 * exist on `Client` or accepts a non-stream body — this `cargo run` fails. */
			const mainRs = `use mock_sdk::Client;
use mock_sdk::ClientConfig;
use mock_sdk::client::UploadBlobOpts;
use bytes::Bytes;
use futures::stream;
use sha2::{Digest, Sha256};
use std::env;

#[tokio::main]
async fn main() {
    let total: usize = 1024 * 1024;
    let chunk: usize = 1024;
    let mut buf = vec![0u8; total];
    for i in 0..total { buf[i] = (i & 0xFF) as u8; }
    let mut hasher = Sha256::new();
    hasher.update(&buf);
    let expected = hex::encode(hasher.finalize());

    let chunks: Vec<Result<Bytes, reqwest::Error>> = (0..total)
        .step_by(chunk)
        .map(|off| {
            let end = (off + chunk).min(total);
            Ok(Bytes::copy_from_slice(&buf[off..end]))
        })
        .collect();
    let s = stream::iter(chunks);

    let client = Client::new(ClientConfig {
        base_url: env::var("BASE_URL").unwrap(),
        bearer_token: Some("valid-token".to_string()),
        ..Default::default()
    });
    let result = client.upload_blob(s, &UploadBlobOpts::default()).await.unwrap();
    let out = serde_json::json!({
        "size": result["size"],
        "hash": result["hash"],
        "expected": expected,
        "total": total,
    });
    println!("{}", out);
}
`
			writeFileSync(join(runnerDir, "src", "main.rs"), mainRs, "utf8")

			let stdout: string
			try {
				stdout = execSync("cargo run", {
					cwd: runnerDir,
					encoding: "utf8",
					env: { ...process.env, BASE_URL: `http://127.0.0.1:${port}` },
					timeout: 240_000,
				})
			} catch (err: unknown) {
				const e = err as { stderr?: string; stdout?: string; message?: string }
				throw new Error(
					`cargo run failed:\nstderr: ${e.stderr ?? ""}\nstdout: ${e.stdout ?? ""}\n${e.message ?? ""}`,
					{ cause: err },
				)
			}

			const result = JSON.parse(stdout.trim()) as {
				size: number
				hash: string
				expected: string
				total: number
			}
			expect(result.size).toBe(result.total)
			expect(result.hash).toBe(result.expected)
		} finally {
			kill()
			rmSync(dir, { force: true, recursive: true })
		}
	}, 240_000)

	it("Test 8.b.1 — Transport trait + default adapters compile + ResumableConnection::connect public", () => {
		const spec = loadMockSpec()
		/* Force realtime module emission: spec has no x-realtime op, so realtime.rs would be
		 * skipped. Inject one to exercise the trait surface. */
		const patched = JSON.parse(JSON.stringify(spec)) as {
			paths: Record<string, Record<string, Record<string, unknown>>>
		}
		patched.paths["/realtime"] = {
			get: {
				operationId: "connectRealtime",
				parameters: [],
				responses: { "101": { description: "Switching Protocols" } },
				summary: "Realtime channel (8.b.1 compile gate)",
				"x-realtime": true,
			},
		}
		const { files } = generateRustSDK(patched as unknown as Parameters<typeof generateRustSDK>[0], {
			crateName: "mock-sdk",
		})
		const dir = mkdtempSync(join(tmpdir(), "honey-rust-harness-8b1-"))
		try {
			const sdkDir = join(dir, "mock-sdk")
			for (const [filename, content] of Object.entries(files)) {
				const dest = join(sdkDir, filename)
				mkdirSync(join(dest, ".."), { recursive: true })
				writeFileSync(dest, content, "utf8")
			}

			const runnerDir = join(dir, "runner")
			mkdirSync(join(runnerDir, "src"), { recursive: true })

			const runnerCargoToml = `[package]
name = "runner"
version = "0.1.0"
edition = "2021"

[dependencies]
mock-sdk = { path = "../mock-sdk" }
serde_json = "1"
tokio = { version = "1", features = ["full"] }
async-trait = "0.1"
`
			writeFileSync(join(runnerDir, "Cargo.toml"), runnerCargoToml, "utf8")

			/* cargo build gate — exercises the public Transport trait, TransportOpts,
			 * TransportConn, all three default adapters, and ResumableConnection::connect.
			 * Behavioural fallback test lands in 8.d.1. */
			const mainRs = `#![allow(dead_code, deprecated)]
use mock_sdk::realtime::{
    LongpollTransport, ResumableConnection, ResumableConnectionOpts,
    SseTransport, Transport, TransportKind, TransportOpts, WsTransport,
};
use std::collections::HashMap;

fn _assert_transport_object_safe(_t: Box<dyn Transport>) {}

fn _build_chain() -> Vec<Box<dyn Transport>> {
    vec![
        Box::new(WsTransport::default()),
        Box::new(SseTransport::default()),
        Box::new(LongpollTransport::default()),
    ]
}

async fn _smoke() {
    let chain = _build_chain();
    let opts = ResumableConnectionOpts::default();
    /* call compiles; runtime failure fine — this test doesn't execute _smoke. */
    let _r = ResumableConnection::<serde_json::Value, serde_json::Value>::connect(
        "http://127.0.0.1:1/missing".to_string(),
        opts,
        chain,
    )
    .await;

    let _t: TransportOpts = TransportOpts {
        headers: HashMap::new(),
        ..Default::default()
    };
    let _k: TransportKind = TransportKind::Ws;
    let _names: [&'static str; 3] = [
        WsTransport::default().name(),
        SseTransport::default().name(),
        LongpollTransport::default().name(),
    ];
}

fn main() {
    println!("{}", serde_json::json!({ "ok": true }));
}
`
			writeFileSync(join(runnerDir, "src", "main.rs"), mainRs, "utf8")

			try {
				execSync("cargo build --quiet", {
					cwd: runnerDir,
					encoding: "utf8",
					timeout: 240_000,
				})
			} catch (err: unknown) {
				const e = err as { stderr?: string; stdout?: string; message?: string }
				throw new Error(
					`cargo build failed:\nstderr: ${e.stderr ?? ""}\nstdout: ${e.stdout ?? ""}\n${e.message ?? ""}`,
					{ cause: err },
				)
			}
			expect(true).toBe(true)
		} finally {
			rmSync(dir, { force: true, recursive: true })
		}
	}, 300_000)

	it("Test 8.c.3 — connect_with_defaults + custom chain compile, deprecated new_* removed", () => {
		const spec = loadMockSpec()
		const patched = JSON.parse(JSON.stringify(spec)) as {
			paths: Record<string, Record<string, Record<string, unknown>>>
		}
		patched.paths["/realtime"] = {
			get: {
				operationId: "connectRealtime",
				parameters: [],
				responses: { "101": { description: "Switching Protocols" } },
				summary: "Realtime channel (8.c.3 compile gate)",
				"x-realtime": true,
			},
		}
		const { files } = generateRustSDK(patched as unknown as Parameters<typeof generateRustSDK>[0], {
			crateName: "mock-sdk",
		})

		/* Grep gate: emitted realtime.rs must no longer expose the legacy constructors. */
		const realtime = files["src/realtime.rs"] ?? ""
		expect(realtime).not.toMatch(/\bfn\s+new_ws\b/)
		expect(realtime).not.toMatch(/\bfn\s+new_sse\b/)
		expect(realtime).not.toMatch(/\bfn\s+new_longpoll\b/)
		expect(realtime).not.toContain("#[deprecated")
		expect(realtime).toMatch(/fn\s+connect_with_defaults\s*\(/)

		const dir = mkdtempSync(join(tmpdir(), "honey-rust-harness-8c3-"))
		try {
			const sdkDir = join(dir, "mock-sdk")
			for (const [filename, content] of Object.entries(files)) {
				const dest = join(sdkDir, filename)
				mkdirSync(join(dest, ".."), { recursive: true })
				writeFileSync(dest, content, "utf8")
			}

			const runnerDir = join(dir, "runner")
			mkdirSync(join(runnerDir, "src"), { recursive: true })

			const runnerCargoToml = `[package]
name = "runner"
version = "0.1.0"
edition = "2021"

[dependencies]
mock-sdk = { path = "../mock-sdk" }
serde_json = "1"
tokio = { version = "1", features = ["full"] }
async-trait = "0.1"
`
			writeFileSync(join(runnerDir, "Cargo.toml"), runnerCargoToml, "utf8")

			const mainRs = `#![allow(dead_code)]
use mock_sdk::realtime::{
    LongpollTransport, ResumableConnection, ResumableConnectionOpts,
    SseTransport, Transport, WsTransport,
};

async fn _default_chain() {
    let opts = ResumableConnectionOpts::default();
    /* default chain helper */
    let _r = ResumableConnection::<serde_json::Value, serde_json::Value>::connect_with_defaults(
        "http://127.0.0.1:1/missing".to_string(),
        opts,
    )
    .await;
}

async fn _custom_chain() {
    /* custom chain: SSE first, then WS fallback */
    let chain: Vec<Box<dyn Transport>> = vec![
        Box::new(SseTransport::default()),
        Box::new(WsTransport),
        Box::new(LongpollTransport::default()),
    ];
    let _r = ResumableConnection::<serde_json::Value, serde_json::Value>::connect(
        "http://127.0.0.1:1/missing".to_string(),
        ResumableConnectionOpts::default(),
        chain,
    )
    .await;
}

fn main() {
    println!("{}", serde_json::json!({ "ok": true }));
}
`
			writeFileSync(join(runnerDir, "src", "main.rs"), mainRs, "utf8")

			try {
				execSync("cargo build --quiet", {
					cwd: runnerDir,
					encoding: "utf8",
					timeout: 240_000,
				})
			} catch (err: unknown) {
				const e = err as { stderr?: string; stdout?: string; message?: string }
				throw new Error(
					`cargo build failed:\nstderr: ${e.stderr ?? ""}\nstdout: ${e.stdout ?? ""}\n${e.message ?? ""}`,
					{ cause: err },
				)
			}
			expect(true).toBe(true)
		} finally {
			rmSync(dir, { force: true, recursive: true })
		}
	}, 300_000)

	it("Test 8.d.1 — ResumableConnection drops mid-stream, reconnects via alternate Transport, resumes events", () => {
		const spec = loadMockSpec()
		const patched = JSON.parse(JSON.stringify(spec)) as {
			paths: Record<string, Record<string, Record<string, unknown>>>
		}
		patched.paths["/realtime"] = {
			get: {
				operationId: "connectRealtime",
				parameters: [],
				responses: { "101": { description: "Switching Protocols" } },
				summary: "Realtime channel (8.d.1 drop-reconnect gate)",
				"x-realtime": true,
			},
		}
		const { files } = generateRustSDK(patched as unknown as Parameters<typeof generateRustSDK>[0], {
			crateName: "mock-sdk",
		})

		const dir = mkdtempSync(join(tmpdir(), "honey-rust-harness-8d1-"))
		try {
			const sdkDir = join(dir, "mock-sdk")
			for (const [filename, content] of Object.entries(files)) {
				const dest = join(sdkDir, filename)
				mkdirSync(join(dest, ".."), { recursive: true })
				writeFileSync(dest, content, "utf8")
			}

			const runnerDir = join(dir, "runner")
			mkdirSync(join(runnerDir, "src"), { recursive: true })

			const runnerCargoToml = `[package]
name = "runner"
version = "0.1.0"
edition = "2021"

[dependencies]
mock-sdk = { path = "../mock-sdk" }
serde_json = "1"
tokio = { version = "1", features = ["full"] }
async-trait = "0.1"
`
			writeFileSync(join(runnerDir, "Cargo.toml"), runnerCargoToml, "utf8")

			const mainRs = `use mock_sdk::realtime::{
    RealtimeError, ResumableConnection, ResumableConnectionOpts,
    Transport, TransportConn, TransportKind, TransportOpts,
};
use async_trait::async_trait;
use std::sync::Arc;
use tokio::sync::Mutex;

/* FlakyConn: yields one event, then returns Recv error forever. */
struct FlakyConn { yielded: bool }

#[async_trait]
impl TransportConn for FlakyConn {
    fn kind(&self) -> TransportKind { TransportKind::Ws }
    async fn send_json(&mut self, _v: serde_json::Value) -> Result<(), RealtimeError> { Ok(()) }
    async fn recv_json(&mut self) -> Result<serde_json::Value, RealtimeError> {
        if !self.yielded {
            self.yielded = true;
            return Ok(serde_json::json!({"src": "A", "seq": 1}));
        }
        Err(RealtimeError::Recv(mock_sdk::errors::Error::Other(
            "simulated mid-stream drop".into(),
        )))
    }
    async fn close(&mut self) -> Result<(), RealtimeError> { Ok(()) }
}

struct FlakyAdapter { calls: Arc<Mutex<u32>> }

#[async_trait]
impl Transport for FlakyAdapter {
    fn name(&self) -> &'static str { "flaky-ws" }
    fn kind(&self) -> TransportKind { TransportKind::Ws }
    async fn connect(
        &self,
        _url: &str,
        _opts: &TransportOpts,
    ) -> Result<Box<dyn TransportConn>, RealtimeError> {
        let mut c = self.calls.lock().await;
        *c += 1;
        let call = *c;
        drop(c);
        if call == 1 {
            Ok(Box::new(FlakyConn { yielded: false }))
        } else {
            /* subsequent dials fail at connect so the chain falls through to
             * the stable adapter deterministically. */
            Err(RealtimeError::Connect(mock_sdk::errors::Error::Other(
                "flaky adapter refuses reconnect".into(),
            )))
        }
    }
}

struct StableConn { events: Vec<serde_json::Value>, idx: usize }

#[async_trait]
impl TransportConn for StableConn {
    fn kind(&self) -> TransportKind { TransportKind::Sse }
    async fn send_json(&mut self, _v: serde_json::Value) -> Result<(), RealtimeError> { Ok(()) }
    async fn recv_json(&mut self) -> Result<serde_json::Value, RealtimeError> {
        if self.idx >= self.events.len() {
            std::future::pending::<()>().await;
            unreachable!()
        }
        let v = self.events[self.idx].clone();
        self.idx += 1;
        Ok(v)
    }
    async fn close(&mut self) -> Result<(), RealtimeError> { Ok(()) }
}

struct StableAdapter { calls: Arc<Mutex<u32>> }

#[async_trait]
impl Transport for StableAdapter {
    fn name(&self) -> &'static str { "stable-sse" }
    fn kind(&self) -> TransportKind { TransportKind::Sse }
    async fn connect(
        &self,
        _url: &str,
        _opts: &TransportOpts,
    ) -> Result<Box<dyn TransportConn>, RealtimeError> {
        let mut c = self.calls.lock().await;
        *c += 1;
        Ok(Box::new(StableConn {
            events: vec![
                serde_json::json!({"src": "B", "seq": 1}),
                serde_json::json!({"src": "B", "seq": 2}),
            ],
            idx: 0,
        }))
    }
}

#[tokio::main]
async fn main() {
    let flaky_calls = Arc::new(Mutex::new(0u32));
    let stable_calls = Arc::new(Mutex::new(0u32));
    let transports: Vec<Box<dyn Transport>> = vec![
        Box::new(FlakyAdapter { calls: flaky_calls.clone() }),
        Box::new(StableAdapter { calls: stable_calls.clone() }),
    ];
    let opts = ResumableConnectionOpts {
        reconnect_delay_ms: Some(10),
        max_reconnect_attempts: Some(5),
        ..Default::default()
    };
    let mut rc = ResumableConnection::<serde_json::Value, serde_json::Value>::connect(
        "http://test.local/rt".to_string(),
        opts,
        transports,
    )
    .await
    .expect("connect");

    let e1 = tokio::time::timeout(std::time::Duration::from_secs(5), rc.recv())
        .await
        .expect("timeout e1")
        .expect("e1");
    let e2 = tokio::time::timeout(std::time::Duration::from_secs(5), rc.recv())
        .await
        .expect("timeout e2")
        .expect("e2");
    let e3 = tokio::time::timeout(std::time::Duration::from_secs(5), rc.recv())
        .await
        .expect("timeout e3")
        .expect("e3");

    let proven = rc.proven_transport();
    let _ = rc.close().await;

    let proven_str = match proven {
        Some(TransportKind::Ws) => "ws",
        Some(TransportKind::Sse) => "sse",
        Some(TransportKind::Longpoll) => "longpoll",
        None => "",
    };

    let out = serde_json::json!({
        "events": [e1, e2, e3],
        "flaky_calls": *flaky_calls.lock().await,
        "stable_calls": *stable_calls.lock().await,
        "proven_kind": proven_str,
    });
    println!("{}", out);
}
`
			writeFileSync(join(runnerDir, "src", "main.rs"), mainRs, "utf8")

			let stdout: string
			try {
				stdout = execSync("cargo run --quiet", {
					cwd: runnerDir,
					encoding: "utf8",
					timeout: 300_000,
				})
			} catch (err: unknown) {
				const e = err as { stderr?: string; stdout?: string; message?: string }
				throw new Error(
					`cargo run failed:\nstderr: ${e.stderr ?? ""}\nstdout: ${e.stdout ?? ""}\n${e.message ?? ""}`,
					{ cause: err },
				)
			}

			const parsed = JSON.parse(stdout.trim()) as {
				events: Array<Record<string, unknown>>
				flaky_calls: number
				stable_calls: number
				proven_kind: string
			}
			expect(parsed.events).toHaveLength(3)
			expect(parsed.events[0]).toEqual({ seq: 1, src: "A" })
			expect(parsed.events[1]).toEqual({ seq: 1, src: "B" })
			expect(parsed.events[2]).toEqual({ seq: 2, src: "B" })
			expect(parsed.flaky_calls).toBe(2)
			expect(parsed.stable_calls).toBe(1)
			expect(parsed.proven_kind).toBe("sse")
		} finally {
			rmSync(dir, { force: true, recursive: true })
		}
	}, 300_000)

	it("Test 8.d.2 — ResumableConnection::connect with a single custom Transport replaces default chain", () => {
		const spec = loadMockSpec()
		const patched = JSON.parse(JSON.stringify(spec)) as {
			paths: Record<string, Record<string, Record<string, unknown>>>
		}
		patched.paths["/realtime"] = {
			get: {
				operationId: "connectRealtime",
				parameters: [],
				responses: { "101": { description: "Switching Protocols" } },
				summary: "Realtime channel (8.d.2 adapter swap gate)",
				"x-realtime": true,
			},
		}
		const { files } = generateRustSDK(patched as unknown as Parameters<typeof generateRustSDK>[0], {
			crateName: "mock-sdk",
		})

		const dir = mkdtempSync(join(tmpdir(), "honey-rust-harness-8d2-"))
		try {
			const sdkDir = join(dir, "mock-sdk")
			for (const [filename, content] of Object.entries(files)) {
				const dest = join(sdkDir, filename)
				mkdirSync(join(dest, ".."), { recursive: true })
				writeFileSync(dest, content, "utf8")
			}

			const runnerDir = join(dir, "runner")
			mkdirSync(join(runnerDir, "src"), { recursive: true })

			const runnerCargoToml = `[package]
name = "runner"
version = "0.1.0"
edition = "2021"

[dependencies]
mock-sdk = { path = "../mock-sdk" }
serde_json = "1"
tokio = { version = "1", features = ["full"] }
async-trait = "0.1"
`
			writeFileSync(join(runnerDir, "Cargo.toml"), runnerCargoToml, "utf8")

			const mainRs = `use mock_sdk::realtime::{
    RealtimeError, ResumableConnection, ResumableConnectionOpts,
    Transport, TransportConn, TransportKind, TransportOpts,
};
use async_trait::async_trait;
use std::sync::Arc;
use tokio::sync::Mutex;

struct CustomConn { events: Vec<serde_json::Value>, idx: usize }

#[async_trait]
impl TransportConn for CustomConn {
    fn kind(&self) -> TransportKind { TransportKind::Ws }
    async fn send_json(&mut self, _v: serde_json::Value) -> Result<(), RealtimeError> { Ok(()) }
    async fn recv_json(&mut self) -> Result<serde_json::Value, RealtimeError> {
        if self.idx >= self.events.len() {
            std::future::pending::<()>().await;
            unreachable!()
        }
        let v = self.events[self.idx].clone();
        self.idx += 1;
        Ok(v)
    }
    async fn close(&mut self) -> Result<(), RealtimeError> { Ok(()) }
}

struct CustomAdapter { calls: Arc<Mutex<u32>> }

#[async_trait]
impl Transport for CustomAdapter {
    fn name(&self) -> &'static str { "custom" }
    fn kind(&self) -> TransportKind { TransportKind::Ws }
    async fn connect(
        &self,
        _url: &str,
        _opts: &TransportOpts,
    ) -> Result<Box<dyn TransportConn>, RealtimeError> {
        let mut c = self.calls.lock().await;
        *c += 1;
        Ok(Box::new(CustomConn {
            events: vec![
                serde_json::json!({"kind": "custom", "seq": 1}),
                serde_json::json!({"kind": "custom", "seq": 2}),
            ],
            idx: 0,
        }))
    }
}

#[tokio::main]
async fn main() {
    let calls = Arc::new(Mutex::new(0u32));
    let adapter = CustomAdapter { calls: calls.clone() };
    let transports: Vec<Box<dyn Transport>> = vec![Box::new(adapter)];
    let mut rc = ResumableConnection::<serde_json::Value, serde_json::Value>::connect(
        "http://test.local/rt".to_string(),
        ResumableConnectionOpts::default(),
        transports,
    )
    .await
    .expect("connect");

    let e1 = rc.recv().await.expect("e1");
    let e2 = rc.recv().await.expect("e2");
    let proven = rc.proven_transport();
    let _ = rc.close().await;

    let proven_str = match proven {
        Some(TransportKind::Ws) => "ws",
        Some(TransportKind::Sse) => "sse",
        Some(TransportKind::Longpoll) => "longpoll",
        None => "",
    };

    let out = serde_json::json!({
        "events": [e1, e2],
        "custom_calls": *calls.lock().await,
        "proven_kind": proven_str,
    });
    println!("{}", out);
}
`
			writeFileSync(join(runnerDir, "src", "main.rs"), mainRs, "utf8")

			let stdout: string
			try {
				stdout = execSync("cargo run --quiet", {
					cwd: runnerDir,
					encoding: "utf8",
					timeout: 300_000,
				})
			} catch (err: unknown) {
				const e = err as { stderr?: string; stdout?: string; message?: string }
				throw new Error(
					`cargo run failed:\nstderr: ${e.stderr ?? ""}\nstdout: ${e.stdout ?? ""}\n${e.message ?? ""}`,
					{ cause: err },
				)
			}

			const parsed = JSON.parse(stdout.trim()) as {
				events: Array<Record<string, unknown>>
				custom_calls: number
				proven_kind: string
			}
			expect(parsed.events).toHaveLength(2)
			expect(parsed.events[0]).toEqual({ kind: "custom", seq: 1 })
			expect(parsed.events[1]).toEqual({ kind: "custom", seq: 2 })
			expect(parsed.custom_calls).toBe(1)
			expect(parsed.proven_kind).toBe("ws")
		} finally {
			rmSync(dir, { force: true, recursive: true })
		}
	}, 300_000)

	it("Test 9.a.5 — x-idempotency-key op auto-generates UUID, honors explicit field, headers win", async () => {
		const spec = loadMockSpec()
		const { files } = generateRustSDK(spec, { crateName: "mock-sdk" })
		const dir = mkdtempSync(join(tmpdir(), "honey-rust-harness-9a5-"))
		const { kill, port } = await startMockServerSubprocess()
		try {
			const sdkDir = join(dir, "mock-sdk")
			for (const [filename, content] of Object.entries(files)) {
				const dest = join(sdkDir, filename)
				mkdirSync(join(dest, ".."), { recursive: true })
				writeFileSync(dest, content, "utf8")
			}

			const runnerDir = join(dir, "runner")
			mkdirSync(join(runnerDir, "src"), { recursive: true })

			const runnerCargoToml = `[package]
name = "runner"
version = "0.1.0"
edition = "2021"

[dependencies]
mock-sdk = { path = "../mock-sdk" }
serde_json = "1"
tokio = { version = "1", features = ["full"] }
`
			writeFileSync(join(runnerDir, "Cargo.toml"), runnerCargoToml, "utf8")

			const mainRs = `use mock_sdk::Client;
use mock_sdk::ClientConfig;
use mock_sdk::client::IdempotentCreateOpts;
use std::collections::HashMap;
use std::env;

#[tokio::main]
async fn main() {
    let base_url = env::var("BASE_URL").unwrap();
    let client = Client::new(ClientConfig { base_url, ..Default::default() });

    let auto = client.idempotent_create(&IdempotentCreateOpts::default()).await.unwrap();

    let mut opts_explicit = IdempotentCreateOpts::default();
    opts_explicit.idempotency_key = Some("user-supplied-key-123".to_string());
    let explicit = client.idempotent_create(&opts_explicit).await.unwrap();

    let mut opts_win = IdempotentCreateOpts::default();
    opts_win.idempotency_key = Some("should-be-ignored".to_string());
    let mut hdrs = HashMap::new();
    hdrs.insert("Idempotency-Key".to_string(), "header-wins-key".to_string());
    opts_win.headers = Some(hdrs);
    let header_win = client.idempotent_create(&opts_win).await.unwrap();

    /* response type is serde_json::Value (inline schema, not a $ref) */
    let out = serde_json::json!({
        "auto": auto["idempotencyKey"],
        "explicit": explicit["idempotencyKey"],
        "header_win": header_win["idempotencyKey"],
    });
    println!("{}", out);
}
`
			writeFileSync(join(runnerDir, "src", "main.rs"), mainRs, "utf8")

			let stdout: string
			try {
				stdout = execSync("cargo run", {
					cwd: runnerDir,
					encoding: "utf8",
					env: { ...process.env, BASE_URL: `http://127.0.0.1:${port}` },
					timeout: 180_000,
				})
			} catch (err: unknown) {
				const e = err as { stderr?: string; stdout?: string; message?: string }
				throw new Error(
					`cargo run failed:\nstderr: ${e.stderr ?? ""}\nstdout: ${e.stdout ?? ""}\n${e.message ?? ""}`,
					{ cause: err },
				)
			}

			const result = JSON.parse(stdout.trim()) as {
				auto: string
				explicit: string
				header_win: string
			}
			expect(result.auto).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
			expect(result.explicit).toBe("user-supplied-key-123")
			expect(result.header_win).toBe("header-wins-key")
		} finally {
			kill()
			rmSync(dir, { force: true, recursive: true })
		}
	}, 300_000)

	/* ------------------------------------------------------------------
	 * Phase 10 — WebSocket behavioural audit (10.a.1)
	 * ------------------------------------------------------------------ */

	async function runRustWsCase(mainRs: string, extraCargoDeps: string): Promise<unknown> {
		const spec = loadMockSpec()
		const { files } = generateRustSDK(spec, { crateName: "mock-sdk" })
		const dir = mkdtempSync(join(tmpdir(), "honey-rust-harness-ws-"))
		const { kill, port } = await startMockServerSubprocess()
		try {
			const sdkDir = join(dir, "mock-sdk")
			for (const [filename, content] of Object.entries(files)) {
				const dest = join(sdkDir, filename)
				mkdirSync(join(dest, ".."), { recursive: true })
				writeFileSync(dest, content, "utf8")
			}

			const runnerDir = join(dir, "runner")
			mkdirSync(join(runnerDir, "src"), { recursive: true })

			const runnerCargoToml = `[package]
name = "runner"
version = "0.1.0"
edition = "2021"

[dependencies]
mock-sdk = { path = "../mock-sdk" }
serde_json = "1"
tokio = { version = "1", features = ["full"] }
${extraCargoDeps}
`
			writeFileSync(join(runnerDir, "Cargo.toml"), runnerCargoToml, "utf8")
			writeFileSync(join(runnerDir, "src", "main.rs"), mainRs, "utf8")

			const stdout = execSync("cargo run", {
				cwd: runnerDir,
				encoding: "utf8",
				env: { ...process.env, BASE_URL: `http://127.0.0.1:${port}` },
				timeout: 300_000,
			})
			return JSON.parse(stdout.trim())
		} finally {
			kill()
			rmSync(dir, { force: true, recursive: true })
		}
	}

	it("Test 10.a.1 WS-A — connect + send + recv echo", async () => {
		const mainRs = `use mock_sdk::Client;
use mock_sdk::ClientConfig;
use mock_sdk::client::ConnectWsOpts;
use std::env;

#[tokio::main]
async fn main() {
    let client = Client::new(ClientConfig { base_url: env::var("BASE_URL").unwrap(), ..Default::default() });
    let mut ws = client.connect_ws(&ConnectWsOpts::default()).await.unwrap();
    ws.send(&serde_json::Value::String("hello".into())).await.unwrap();
    let msg = ws.read().await.unwrap();
    let received = String::from_utf8(msg).unwrap();
    let _ = ws.close(1000, "done").await;
    println!("{}", serde_json::json!({ "received": received }));
}
`
		const result = await runRustWsCase(mainRs, "") as { received: string }
		/* Rust emits send via JSON-encode → "hello" becomes "\"hello\"" */
		expect(JSON.parse(result.received)).toBe("hello")
	}, 300_000)

	it("Test 10.a.1 WS-B — client-initiated close terminates connection", async () => {
		const mainRs = `use mock_sdk::Client;
use mock_sdk::ClientConfig;
use mock_sdk::client::ConnectWsOpts;
use std::env;

#[tokio::main]
async fn main() {
    let client = Client::new(ClientConfig { base_url: env::var("BASE_URL").unwrap(), ..Default::default() });
    let mut ws = client.connect_ws(&ConnectWsOpts::default()).await.unwrap();
    ws.close(1000, "client-bye").await.unwrap();
    let read_result = ws.read().await;
    let err = read_result.is_err();
    println!("{}", serde_json::json!({ "err": err }));
}
`
		const result = await runRustWsCase(mainRs, "") as { err: boolean }
		expect(result.err).toBe(true)
	}, 300_000)

	it("Test 10.a.1 WS-C — server-initiated close detected", async () => {
		const mainRs = `use mock_sdk::Client;
use mock_sdk::ClientConfig;
use mock_sdk::client::ConnectWsOpts;
use std::env;

#[tokio::main]
async fn main() {
    let client = Client::new(ClientConfig { base_url: env::var("BASE_URL").unwrap(), ..Default::default() });
    let mut ws = client.connect_ws(&ConnectWsOpts::default()).await.unwrap();
    ws.send(&serde_json::Value::String("__close__".into())).await.unwrap();
    let r = ws.read().await;
    let err_msg = match r { Ok(_) => "NO_ERR".to_string(), Err(e) => format!("{:?}", e) };
    println!("{}", serde_json::json!({ "err_msg": err_msg }));
}
`
		const result = await runRustWsCase(mainRs, "") as { err_msg: string }
		/* Rust ws.rs returns Error::Other("connection closed by peer") on Close frame.
		 * Close-frame code/reason not surfaced today — BLOCKER captured in 10.a.2 log. */
		expect(result.err_msg).toMatch(/connection closed/)
	}, 300_000)

	it("Test 10.a.1 WS-D — auth handshake via ?token= query-param", async () => {
		const mainRs = `use mock_sdk::Client;
use mock_sdk::ClientConfig;
use mock_sdk::client::ConnectWsOpts;
use std::env;

#[tokio::main]
async fn main() {
    let client = Client::new(ClientConfig { base_url: env::var("BASE_URL").unwrap(), ..Default::default() });

    let mut ok_opts = ConnectWsOpts::default();
    ok_opts.token = Some("valid-token".to_string());
    let mut ws = client.connect_ws(&ok_opts).await.unwrap();
    ws.send(&serde_json::Value::String("ping".into())).await.unwrap();
    let msg = ws.read().await.unwrap();
    let ok_received = String::from_utf8(msg).unwrap();
    let _ = ws.close(1000, "done").await;

    let mut bad_opts = ConnectWsOpts::default();
    bad_opts.token = Some("bogus-token".to_string());
    let mut bad_ws = client.connect_ws(&bad_opts).await.unwrap();
    let _ = bad_ws.send(&serde_json::Value::String("ping".into())).await;
    let bad_read = bad_ws.read().await;
    let bad_err = match bad_read { Ok(v) => format!("OK:{}", String::from_utf8_lossy(&v)), Err(e) => format!("ERR:{:?}", e) };

    println!("{}", serde_json::json!({ "ok_received": ok_received, "bad_err": bad_err }));
}
`
		const result = await runRustWsCase(mainRs, "") as { ok_received: string; bad_err: string }
		expect(JSON.parse(result.ok_received)).toBe("ping")
		/* Bad-token close surfaces as read error; not structured with 4401 today.
		 * Close-frame code parity deferred to 10.a.2 runtime patch. */
		expect(result.bad_err).toMatch(/^ERR:/)
	}, 300_000)

	/* Ping/pong: auto-handled by tokio-tungstenite, not user-observable.
	 * Out of scope per master spec §11. BLOCKER if exposed later. */
	it.skip("Test 10.a.1 WS-E — ping/pong auto-handled (not user-observable)", () => {})
})
