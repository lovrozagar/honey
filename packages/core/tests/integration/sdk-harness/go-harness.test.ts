import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { execSync } from "node:child_process"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { generateGoSDK } from "../../../src/codegen-go.ts"
import { hasBinary, loadMockSpec, startMockServerSubprocess } from "./harness-util.ts"

const hasGo = hasBinary("go")

describe.skipIf(!hasGo)("Go SDK integration harness", () => {
	it("round-trip: createUser + getUser", async () => {
		const spec = loadMockSpec()
		const { files } = generateGoSDK(spec, { modulePath: "example.com/mock-sdk" })
		const dir = mkdtempSync(join(tmpdir(), "honey-go-harness-"))
		const { kill, port } = await startMockServerSubprocess()
		try {
			const sdkDir = join(dir, "sdk")
			mkdirSync(sdkDir, { recursive: true })
			for (const [filename, content] of Object.entries(files)) {
				const dest = join(sdkDir, filename)
				mkdirSync(join(dest, ".."), { recursive: true })
				writeFileSync(dest, content, "utf8")
			}

			const mainGo = `package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	sdk "example.com/mock-sdk"
)

func main() {
	client := sdk.NewClient(sdk.Config{
		BaseURL:     os.Getenv("BASE_URL"),
		BearerToken: "valid-token",
	})
	ctx := context.Background()
	created, err := client.CreateUser(ctx, sdk.UserCreate{Name: "Alice", Email: "a@b.com"}, nil)
	if err != nil {
		panic(err)
	}
	fetched, err := client.GetUser(ctx, created.Id, nil)
	if err != nil {
		panic(err)
	}
	out, _ := json.Marshal(map[string]interface{}{"created": created, "fetched": fetched})
	fmt.Println(string(out))
}
`
			writeFileSync(join(dir, "main.go"), mainGo, "utf8")

			const goMod = `module test-harness

go 1.23

require example.com/mock-sdk v0.0.0

replace example.com/mock-sdk => ./sdk
`
			writeFileSync(join(dir, "go.mod"), goMod, "utf8")

			try {
				execSync("go mod tidy", {
					cwd: dir,
					encoding: "utf8",
					env: { ...process.env, BASE_URL: `http://127.0.0.1:${port}` },
					timeout: 60_000,
				})
			} catch (err: unknown) {
				const e = err as { stderr?: string; stdout?: string; message?: string }
				throw new Error(
					`go mod tidy failed:\nstderr: ${e.stderr ?? ""}\nstdout: ${e.stdout ?? ""}\n${e.message ?? ""}`,
					{ cause: err },
				)
			}

			let stdout: string
			try {
				stdout = execSync("go run main.go", {
					cwd: dir,
					encoding: "utf8",
					env: { ...process.env, BASE_URL: `http://127.0.0.1:${port}` },
					timeout: 60_000,
				})
			} catch (err: unknown) {
				const e = err as { stderr?: string; stdout?: string; message?: string }
				throw new Error(
					`go run main.go failed:\nstderr: ${e.stderr ?? ""}\nstdout: ${e.stdout ?? ""}\n${e.message ?? ""}`,
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
	}, 60_000)

	it("Test M — typed error data: 400 parses into Data field", async () => {
		const spec = loadMockSpec()
		const { files } = generateGoSDK(spec, { modulePath: "example.com/mock-sdk" })
		const dir = mkdtempSync(join(tmpdir(), "honey-go-harness-m-"))
		const { kill, port } = await startMockServerSubprocess()
		try {
			const sdkDir = join(dir, "sdk")
			mkdirSync(sdkDir, { recursive: true })
			for (const [filename, content] of Object.entries(files)) {
				const dest = join(sdkDir, filename)
				mkdirSync(join(dest, ".."), { recursive: true })
				writeFileSync(dest, content, "utf8")
			}

			const mainGo = `package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"reflect"
	sdk "example.com/mock-sdk"
)

func main() {
	client := sdk.NewClient(sdk.Config{
		BaseURL: os.Getenv("BASE_URL"),
	})
	ctx := context.Background()
	_, err := client.GetDeclaredError(ctx, "400", nil)
	out := map[string]interface{}{
		"threw":         err != nil,
		"isBadRequest":  false,
		"status":        0,
		"hasDataField":  false,
		"dataIsNil":     true,
		"dataType":      "",
		"dataMap":       nil,
		"bodyLen":       0,
	}
	if err == nil {
		fmt.Println(mustJSON(out))
		return
	}
	var bre *sdk.BadRequestError
	if errors.As(err, &bre) {
		out["isBadRequest"] = true
		out["status"] = bre.Status()
		out["bodyLen"] = len(bre.Body)
		v := reflect.ValueOf(bre).Elem()
		f := v.FieldByName("Data")
		if f.IsValid() {
			out["hasDataField"] = true
			if f.Kind() == reflect.Interface {
				if !f.IsNil() {
					out["dataIsNil"] = false
					inner := f.Elem()
					out["dataType"] = inner.Type().String()
					if inner.Kind() == reflect.Map {
						m := map[string]interface{}{}
						for _, k := range inner.MapKeys() {
							m[fmt.Sprint(k.Interface())] = inner.MapIndex(k).Interface()
						}
						out["dataMap"] = m
					}
				}
			} else if f.Kind() == reflect.Ptr {
				if !f.IsNil() {
					out["dataIsNil"] = false
					out["dataType"] = f.Type().String()
				}
			}
		}
	}
	fmt.Println(mustJSON(out))
}

func mustJSON(v interface{}) string {
	b, _ := json.Marshal(v)
	return string(b)
}
`
			writeFileSync(join(dir, "main.go"), mainGo, "utf8")

			const goMod = `module test-harness

go 1.23

require example.com/mock-sdk v0.0.0

replace example.com/mock-sdk => ./sdk
`
			writeFileSync(join(dir, "go.mod"), goMod, "utf8")

			try {
				execSync("go mod tidy", {
					cwd: dir,
					encoding: "utf8",
					env: { ...process.env, BASE_URL: `http://127.0.0.1:${port}` },
					timeout: 60_000,
				})
			} catch (err: unknown) {
				const e = err as { stderr?: string; stdout?: string; message?: string }
				throw new Error(
					`go mod tidy failed:\nstderr: ${e.stderr ?? ""}\nstdout: ${e.stdout ?? ""}\n${e.message ?? ""}`,
					{ cause: err },
				)
			}

			let stdout: string
			try {
				stdout = execSync("go run main.go", {
					cwd: dir,
					encoding: "utf8",
					env: { ...process.env, BASE_URL: `http://127.0.0.1:${port}` },
					timeout: 60_000,
				})
			} catch (err: unknown) {
				const e = err as { stderr?: string; stdout?: string; message?: string }
				throw new Error(
					`go run main.go failed:\nstderr: ${e.stderr ?? ""}\nstdout: ${e.stdout ?? ""}\n${e.message ?? ""}`,
					{ cause: err },
				)
			}

			const result = JSON.parse(stdout.trim()) as {
				threw: boolean
				isBadRequest: boolean
				status: number
				hasDataField: boolean
				dataIsNil: boolean
				dataType: string
				dataMap: Record<string, unknown> | null
				bodyLen: number
			}
			expect(result.threw).toBe(true)
			expect(result.isBadRequest).toBe(true)
			expect(result.status).toBe(400)
			expect(result.bodyLen).toBeGreaterThan(0)
			/* RED gate: BadRequestError struct has no Data field today */
			expect(result.hasDataField).toBe(true)
			expect(result.dataIsNil).toBe(false)
			expect(result.dataMap).not.toBeNull()
			expect((result.dataMap ?? {})["status"]).toBe(400)
			expect((result.dataMap ?? {})["message"]).toBe("Bad Request")
		} finally {
			kill()
			rmSync(dir, { force: true, recursive: true })
		}
	}, 60_000)

	it("Test V — per-call headers merge: per-call wins per key, config keys preserved", async () => {
		const spec = loadMockSpec()
		const { files } = generateGoSDK(spec, { modulePath: "example.com/mock-sdk" })
		const dir = mkdtempSync(join(tmpdir(), "honey-go-harness-v-"))
		try {
			const sdkDir = join(dir, "sdk")
			mkdirSync(sdkDir, { recursive: true })
			for (const [filename, content] of Object.entries(files)) {
				const dest = join(sdkDir, filename)
				mkdirSync(join(dest, ".."), { recursive: true })
				writeFileSync(dest, content, "utf8")
			}

			/* in-process httptest server captures the first request headers,
			 * returns a minimal user JSON satisfying the typed response. */
			const mainGo = `package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	sdk "example.com/mock-sdk"
)

func main() {
	var captured http.Header
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		captured = r.Header.Clone()
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(200)
		_, _ = w.Write([]byte(\`{"id":"u1","name":"Alice","email":"a@b.com"}\`))
	}))
	defer srv.Close()

	client := sdk.NewClient(sdk.Config{
		BaseURL: srv.URL,
		Headers: map[string]string{"X-Config": "a", "X-Both": "config"},
	})
	_, err := client.GetUser(context.Background(), "u1", &sdk.GetUserOpts{
		Headers: map[string]string{"X-Call": "c", "X-Both": "call"},
	})
	if err != nil {
		panic(err)
	}
	out := map[string]string{
		"X-Config": captured.Get("X-Config"),
		"X-Call":   captured.Get("X-Call"),
		"X-Both":   captured.Get("X-Both"),
	}
	b, _ := json.Marshal(out)
	fmt.Println(string(b))
}
`
			writeFileSync(join(dir, "main.go"), mainGo, "utf8")

			const goMod = `module test-harness

go 1.23

require example.com/mock-sdk v0.0.0

replace example.com/mock-sdk => ./sdk
`
			writeFileSync(join(dir, "go.mod"), goMod, "utf8")

			try {
				execSync("go mod tidy", {
					cwd: dir,
					encoding: "utf8",
					timeout: 60_000,
				})
			} catch (err: unknown) {
				const e = err as { stderr?: string; stdout?: string; message?: string }
				throw new Error(
					`go mod tidy failed:\nstderr: ${e.stderr ?? ""}\nstdout: ${e.stdout ?? ""}\n${e.message ?? ""}`,
					{ cause: err },
				)
			}

			let stdout: string
			try {
				stdout = execSync("go run main.go", {
					cwd: dir,
					encoding: "utf8",
					timeout: 60_000,
				})
			} catch (err: unknown) {
				const e = err as { stderr?: string; stdout?: string; message?: string }
				throw new Error(
					`go run main.go failed:\nstderr: ${e.stderr ?? ""}\nstdout: ${e.stdout ?? ""}\n${e.message ?? ""}`,
					{ cause: err },
				)
			}

			const captured = JSON.parse(stdout.trim()) as Record<string, string>
			expect(captured["X-Config"]).toBe("a")
			expect(captured["X-Call"]).toBe("c")
			expect(captured["X-Both"]).toBe("call")
		} finally {
			rmSync(dir, { force: true, recursive: true })
		}
	}, 60_000)

	it("Test W — OnRequest/OnResponse hook chain fires in declaration order", async () => {
		const spec = loadMockSpec()
		const { files } = generateGoSDK(spec, { modulePath: "example.com/mock-sdk" })
		const dir = mkdtempSync(join(tmpdir(), "honey-go-harness-w-"))
		try {
			const sdkDir = join(dir, "sdk")
			mkdirSync(sdkDir, { recursive: true })
			for (const [filename, content] of Object.entries(files)) {
				const dest = join(sdkDir, filename)
				mkdirSync(join(dest, ".."), { recursive: true })
				writeFileSync(dest, content, "utf8")
			}

			/* in-process httptest server captures request headers, returns minimal
			 * user JSON so the typed response unmarshal succeeds. Two OnRequest
			 * hooks set distinct headers (verifies both fire and chain pre-send);
			 * two OnResponse hooks record status + a sentinel into shared captures
			 * (verifies both fire and chain post-receive in declaration order). */
			const mainGo = `package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	sdk "example.com/mock-sdk"
)

func main() {
	var capturedHeaders http.Header
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		capturedHeaders = r.Header.Clone()
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(200)
		_, _ = w.Write([]byte(\`{"id":"u1","name":"Alice","email":"a@b.com"}\`))
	}))
	defer srv.Close()

	var capturedStatus int
	chain := []string{}

	client := sdk.NewClient(sdk.Config{
		BaseURL: srv.URL,
		OnRequest: []func(*sdk.RequestContext) error{
			func(c *sdk.RequestContext) error { c.Headers.Set("X-Hook-1", "a"); return nil },
			func(c *sdk.RequestContext) error { c.Headers.Set("X-Hook-2", "b"); return nil },
		},
		OnResponse: []func(*sdk.ResponseContext) error{
			func(c *sdk.ResponseContext) error { capturedStatus = c.Status; chain = append(chain, "resp1"); return nil },
			func(c *sdk.ResponseContext) error { chain = append(chain, "resp2"); return nil },
		},
	})
	_, err := client.GetUser(context.Background(), "u1", nil)
	if err != nil {
		panic(err)
	}
	out := map[string]interface{}{
		"X-Hook-1":   capturedHeaders.Get("X-Hook-1"),
		"X-Hook-2":   capturedHeaders.Get("X-Hook-2"),
		"respStatus": capturedStatus,
		"chain":      chain,
	}
	b, _ := json.Marshal(out)
	fmt.Println(string(b))
}
`
			writeFileSync(join(dir, "main.go"), mainGo, "utf8")

			const goMod = `module test-harness

go 1.23

require example.com/mock-sdk v0.0.0

replace example.com/mock-sdk => ./sdk
`
			writeFileSync(join(dir, "go.mod"), goMod, "utf8")

			try {
				execSync("go mod tidy", {
					cwd: dir,
					encoding: "utf8",
					timeout: 60_000,
				})
			} catch (err: unknown) {
				const e = err as { stderr?: string; stdout?: string; message?: string }
				throw new Error(
					`go mod tidy failed:\nstderr: ${e.stderr ?? ""}\nstdout: ${e.stdout ?? ""}\n${e.message ?? ""}`,
					{ cause: err },
				)
			}

			let stdout: string
			try {
				stdout = execSync("go run main.go", {
					cwd: dir,
					encoding: "utf8",
					timeout: 60_000,
				})
			} catch (err: unknown) {
				const e = err as { stderr?: string; stdout?: string; message?: string }
				throw new Error(
					`go run main.go failed:\nstderr: ${e.stderr ?? ""}\nstdout: ${e.stdout ?? ""}\n${e.message ?? ""}`,
					{ cause: err },
				)
			}

			const result = JSON.parse(stdout.trim()) as {
				"X-Hook-1": string
				"X-Hook-2": string
				respStatus: number
				chain: string[]
			}
			expect(result["X-Hook-1"]).toBe("a")
			expect(result["X-Hook-2"]).toBe("b")
			expect(result.respStatus).toBe(200)
			expect(result.chain).toEqual(["resp1", "resp2"])
		} finally {
			rmSync(dir, { force: true, recursive: true })
		}
	}, 60_000)

	it("Test L1 — OnLog request lifecycle", async () => {
		const spec = loadMockSpec()
		const { files } = generateGoSDK(spec, { modulePath: "example.com/mock-sdk" })
		const dir = mkdtempSync(join(tmpdir(), "honey-go-harness-l1-"))
		const { kill, port } = await startMockServerSubprocess()
		try {
			const sdkDir = join(dir, "sdk")
			mkdirSync(sdkDir, { recursive: true })
			for (const [filename, content] of Object.entries(files)) {
				const dest = join(sdkDir, filename)
				mkdirSync(join(dest, ".."), { recursive: true })
				writeFileSync(dest, content, "utf8")
			}

			const mainGo = `package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"sync"
	sdk "example.com/mock-sdk"
)

func main() {
	var mu sync.Mutex
	var captured []sdk.LogEntry
	client := sdk.NewClient(sdk.Config{
		BaseURL:     os.Getenv("BASE_URL"),
		BearerToken: "valid-token",
		OnLog: func(e sdk.LogEntry) {
			mu.Lock()
			defer mu.Unlock()
			captured = append(captured, e)
		},
	})
	ctx := context.Background()
	_, err := client.CreateUser(ctx, sdk.UserCreate{Name: "Log", Email: "l@l.com"}, nil)
	if err != nil {
		panic(err)
	}
	mu.Lock()
	defer mu.Unlock()
	out := make([]map[string]interface{}, 0, len(captured))
	for _, e := range captured {
		entry := map[string]interface{}{
			"level":       e.Level,
			"event":       e.Event,
			"operation":   e.Operation,
			"duration_ms": e.DurationMs,
		}
		if e.Status != nil {
			entry["status"] = *e.Status
		} else {
			entry["status"] = nil
		}
		out = append(out, entry)
	}
	b, _ := json.Marshal(out)
	fmt.Println(string(b))
}
`
			writeFileSync(join(dir, "main.go"), mainGo, "utf8")

			const goMod = `module test-harness

go 1.23

require example.com/mock-sdk v0.0.0

replace example.com/mock-sdk => ./sdk
`
			writeFileSync(join(dir, "go.mod"), goMod, "utf8")

			try {
				execSync("go mod tidy", {
					cwd: dir,
					encoding: "utf8",
					env: { ...process.env, BASE_URL: `http://127.0.0.1:${port}` },
					timeout: 60_000,
				})
			} catch (err: unknown) {
				const e = err as { stderr?: string; stdout?: string; message?: string }
				throw new Error(
					`go mod tidy failed:\nstderr: ${e.stderr ?? ""}\nstdout: ${e.stdout ?? ""}\n${e.message ?? ""}`,
					{ cause: err },
				)
			}

			let stdout: string
			try {
				stdout = execSync("go run main.go", {
					cwd: dir,
					encoding: "utf8",
					env: { ...process.env, BASE_URL: `http://127.0.0.1:${port}` },
					timeout: 60_000,
				})
			} catch (err: unknown) {
				const e = err as { stderr?: string; stdout?: string; message?: string }
				throw new Error(
					`go run main.go failed:\nstderr: ${e.stderr ?? ""}\nstdout: ${e.stdout ?? ""}\n${e.message ?? ""}`,
					{ cause: err },
				)
			}

			const entries = JSON.parse(stdout.trim()) as Array<{
				level: string
				event: string
				operation: string
				duration_ms: number
				status: number | null
			}>
			expect(entries).toHaveLength(2)
			expect(entries[0].event).toBe("request_start")
			expect(entries[0].level).toBe("debug")
			expect(entries[0].operation).toBe("POST /users")
			expect(entries[0].duration_ms).toBe(0)
			expect(entries[0].status).toBeNull()
			expect(entries[1].event).toBe("response_received")
			expect(entries[1].level).toBe("info")
			expect(entries[1].operation).toBe("POST /users")
			expect(entries[1].status).toBe(201)
			expect(entries[1].duration_ms).toBeGreaterThanOrEqual(0)
			expect(Number.isFinite(entries[1].duration_ms)).toBe(true)
		} finally {
			kill()
			rmSync(dir, { force: true, recursive: true })
		}
	}, 60_000)

	it("Test Z — invalidation: mutation marks matching GET path stale; templated patterns match interpolated path", async () => {
		const spec = loadMockSpec()
		const { files } = generateGoSDK(spec, { modulePath: "example.com/mock-sdk" })
		const dir = mkdtempSync(join(tmpdir(), "honey-go-harness-z-"))
		try {
			const sdkDir = join(dir, "sdk")
			mkdirSync(sdkDir, { recursive: true })
			for (const [filename, content] of Object.entries(files)) {
				const dest = join(sdkDir, filename)
				mkdirSync(join(dest, ".."), { recursive: true })
				writeFileSync(dest, content, "utf8")
			}

			/* in-process httptest server: 201 on POST /users, 200 on PUT /users/u1.
			 * createUser invalidates "GET /users". updateUser invalidates "GET /users"
			 * and templated "GET /users/{id}" — concrete id="u1" must mark
			 * /users/u1 stale, /users/other unaffected. */
			const mainGo = `package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	sdk "example.com/mock-sdk"
)

func main() {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if r.Method == "POST" && r.URL.Path == "/users" {
			w.WriteHeader(201)
			_, _ = w.Write([]byte(\`{"id":"u1","name":"Alice","email":"a@b.com"}\`))
			return
		}
		if r.Method == "PUT" && r.URL.Path == "/users/u1" {
			w.WriteHeader(200)
			_, _ = w.Write([]byte(\`{"id":"u1","name":"Alice2","email":"a@b.com"}\`))
			return
		}
		w.WriteHeader(404)
		_, _ = w.Write([]byte(\`{"message":"not found"}\`))
	}))
	defer srv.Close()

	client := sdk.NewClient(sdk.Config{
		BaseURL: srv.URL,
		Invalidation: &sdk.InvalidationConfig{StaleTime: 5000, StaleMaxEntries: 100},
	})
	ctx := context.Background()

	out := map[string]bool{
		"before_create_users":    client.IsStale("GET", "/users"),
		"before_create_users_u1": client.IsStale("GET", "/users/u1"),
	}
	if _, err := client.CreateUser(ctx, sdk.UserCreate{Name: "Alice", Email: "a@b.com"}, nil); err != nil {
		panic(err)
	}
	out["after_create_users"] = client.IsStale("GET", "/users")
	out["after_create_users_u1"] = client.IsStale("GET", "/users/u1")

	if _, err := client.UpdateUser(ctx, "u1", sdk.UserUpdate{Name: ptrStr("Alice2")}, nil); err != nil {
		panic(err)
	}
	out["after_update_users"] = client.IsStale("GET", "/users")
	out["after_update_users_u1"] = client.IsStale("GET", "/users/u1")
	out["after_update_users_other"] = client.IsStale("GET", "/users/other")

	b, _ := json.Marshal(out)
	fmt.Println(string(b))
}

func ptrStr(s string) *string { return &s }
`
			writeFileSync(join(dir, "main.go"), mainGo, "utf8")

			const goMod = `module test-harness

go 1.23

require example.com/mock-sdk v0.0.0

replace example.com/mock-sdk => ./sdk
`
			writeFileSync(join(dir, "go.mod"), goMod, "utf8")

			try {
				execSync("go mod tidy", {
					cwd: dir,
					encoding: "utf8",
					timeout: 60_000,
				})
			} catch (err: unknown) {
				const e = err as { stderr?: string; stdout?: string; message?: string }
				throw new Error(
					`go mod tidy failed:\nstderr: ${e.stderr ?? ""}\nstdout: ${e.stdout ?? ""}\n${e.message ?? ""}`,
					{ cause: err },
				)
			}

			let stdout: string
			try {
				stdout = execSync("go run main.go", {
					cwd: dir,
					encoding: "utf8",
					timeout: 60_000,
				})
			} catch (err: unknown) {
				const e = err as { stderr?: string; stdout?: string; message?: string }
				throw new Error(
					`go run main.go failed:\nstderr: ${e.stderr ?? ""}\nstdout: ${e.stdout ?? ""}\n${e.message ?? ""}`,
					{ cause: err },
				)
			}

			const parsed = JSON.parse(stdout.trim()) as Record<string, boolean>
			expect(parsed.before_create_users).toBe(false)
			expect(parsed.before_create_users_u1).toBe(false)
			expect(parsed.after_create_users).toBe(true)
			expect(parsed.after_create_users_u1).toBe(false)
			expect(parsed.after_update_users).toBe(true)
			expect(parsed.after_update_users_u1).toBe(true)
			expect(parsed.after_update_users_other).toBe(false)
		} finally {
			rmSync(dir, { force: true, recursive: true })
		}
	}, 60_000)

	it("Test 7.a.4 — streaming upload (io.Reader, 1MB) returns matching size + sha256", async () => {
		const spec = loadMockSpec()
		const { files } = generateGoSDK(spec, { modulePath: "example.com/mock-sdk" })
		const dir = mkdtempSync(join(tmpdir(), "honey-go-harness-upload-"))
		const { kill, port } = await startMockServerSubprocess()
		try {
			const sdkDir = join(dir, "sdk")
			mkdirSync(sdkDir, { recursive: true })
			for (const [filename, content] of Object.entries(files)) {
				const dest = join(sdkDir, filename)
				mkdirSync(join(dest, ".."), { recursive: true })
				writeFileSync(dest, content, "utf8")
			}

			const mainGo = `package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"os"
	sdk "example.com/mock-sdk"
)

/* seqReader produces deterministic bytes: byte[i] = i & 0xFF over total bytes. */
type seqReader struct {
	total int
	pos   int
}

func (r *seqReader) Read(p []byte) (int, error) {
	if r.pos >= r.total {
		return 0, io.EOF
	}
	n := len(p)
	if r.pos+n > r.total {
		n = r.total - r.pos
	}
	for i := 0; i < n; i++ {
		p[i] = byte((r.pos + i) & 0xFF)
	}
	r.pos += n
	return n, nil
}

func main() {
	total := 1024 * 1024
	buf := make([]byte, total)
	for i := 0; i < total; i++ {
		buf[i] = byte(i & 0xFF)
	}
	sum := sha256.Sum256(buf)
	expected := hex.EncodeToString(sum[:])

	client := sdk.NewClient(sdk.Config{
		BaseURL:     os.Getenv("BASE_URL"),
		BearerToken: "valid-token",
	})
	raw, err := client.UploadBlob(context.Background(), &seqReader{total: total}, nil)
	if err != nil {
		panic(err)
	}
	var parsed struct {
		Size int    \`json:"size"\`
		Hash string \`json:"hash"\`
	}
	if err := json.Unmarshal(*raw, &parsed); err != nil {
		panic(err)
	}
	out := map[string]interface{}{
		"size":     parsed.Size,
		"hash":     parsed.Hash,
		"expected": expected,
		"total":    total,
	}
	b, _ := json.Marshal(out)
	fmt.Println(string(b))
}
`
			writeFileSync(join(dir, "main.go"), mainGo, "utf8")

			const goMod = `module test-harness

go 1.23

require example.com/mock-sdk v0.0.0

replace example.com/mock-sdk => ./sdk
`
			writeFileSync(join(dir, "go.mod"), goMod, "utf8")

			try {
				execSync("go mod tidy", {
					cwd: dir,
					encoding: "utf8",
					env: { ...process.env, BASE_URL: `http://127.0.0.1:${port}` },
					timeout: 60_000,
				})
			} catch (err: unknown) {
				const e = err as { stderr?: string; stdout?: string; message?: string }
				throw new Error(
					`go mod tidy failed:\nstderr: ${e.stderr ?? ""}\nstdout: ${e.stdout ?? ""}\n${e.message ?? ""}`,
					{ cause: err },
				)
			}

			let stdout: string
			try {
				stdout = execSync("go run main.go", {
					cwd: dir,
					encoding: "utf8",
					env: { ...process.env, BASE_URL: `http://127.0.0.1:${port}` },
					timeout: 60_000,
				})
			} catch (err: unknown) {
				const e = err as { stderr?: string; stdout?: string; message?: string }
				throw new Error(
					`go run main.go failed:\nstderr: ${e.stderr ?? ""}\nstdout: ${e.stdout ?? ""}\n${e.message ?? ""}`,
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
	}, 60_000)

	it("Test 8.b.3 — Transport interface + default adapters importable with correct Name()/Kind()", () => {
		const spec = loadMockSpec()
		const { files } = generateGoSDK(spec, { modulePath: "example.com/mock-sdk" })
		const dir = mkdtempSync(join(tmpdir(), "honey-go-harness-8b3-"))
		try {
			const sdkDir = join(dir, "sdk")
			mkdirSync(sdkDir, { recursive: true })
			for (const [filename, content] of Object.entries(files)) {
				const dest = join(sdkDir, filename)
				mkdirSync(join(dest, ".."), { recursive: true })
				writeFileSync(dest, content, "utf8")
			}

			const mainGo = `package main

import (
	"encoding/json"
	"fmt"
	sdk "example.com/mock-sdk"
)

/* compile-time interface satisfaction checks — fail at build if any
 * default adapter drifts from the public Transport interface. */
var (
	_ sdk.Transport = (*sdk.WsTransport)(nil)
	_ sdk.Transport = (*sdk.SseTransport)(nil)
	_ sdk.Transport = (*sdk.LongpollTransport)(nil)
)

func main() {
	ws := &sdk.WsTransport{}
	sse := &sdk.SseTransport{}
	lp := &sdk.LongpollTransport{}

	defaults := sdk.TransportOpts{}

	out := map[string]interface{}{
		"ws_name":    ws.Name(),
		"sse_name":   sse.Name(),
		"lp_name":    lp.Name(),
		"ws_kind":    string(ws.Kind()),
		"sse_kind":   string(sse.Kind()),
		"lp_kind":    string(lp.Kind()),
		"opts_defaults": map[string]interface{}{
			"reconnect_token":         defaults.ReconnectToken,
			"last_event_id":           defaults.LastEventID,
			"headers_nil":             defaults.Headers == nil,
			"max_reconnect_attempts":  defaults.MaxReconnectAttempts,
			"reconnect_delay_ms":      defaults.ReconnectDelayMs,
			"protocols_nil":           defaults.Protocols == nil,
			"http_client_nil":         defaults.HTTPClient == nil,
		},
		"kind_consts": []string{string(sdk.TransportWs), string(sdk.TransportSse), string(sdk.TransportLongpoll)},
	}
	b, _ := json.Marshal(out)
	fmt.Println(string(b))
}
`
			writeFileSync(join(dir, "main.go"), mainGo, "utf8")

			const goMod = `module test-harness

go 1.23

require example.com/mock-sdk v0.0.0

replace example.com/mock-sdk => ./sdk
`
			writeFileSync(join(dir, "go.mod"), goMod, "utf8")

			try {
				execSync("go mod tidy", { cwd: dir, encoding: "utf8", timeout: 60_000 })
			} catch (err: unknown) {
				const e = err as { stderr?: string; stdout?: string; message?: string }
				throw new Error(
					`go mod tidy failed:\nstderr: ${e.stderr ?? ""}\nstdout: ${e.stdout ?? ""}\n${e.message ?? ""}`,
					{ cause: err },
				)
			}

			let stdout: string
			try {
				stdout = execSync("go run main.go", { cwd: dir, encoding: "utf8", timeout: 60_000 })
			} catch (err: unknown) {
				const e = err as { stderr?: string; stdout?: string; message?: string }
				throw new Error(
					`go run main.go failed:\nstderr: ${e.stderr ?? ""}\nstdout: ${e.stdout ?? ""}\n${e.message ?? ""}`,
					{ cause: err },
				)
			}

			const result = JSON.parse(stdout.trim()) as {
				ws_name: string
				sse_name: string
				lp_name: string
				ws_kind: string
				sse_kind: string
				lp_kind: string
				opts_defaults: {
					reconnect_token: string
					last_event_id: string
					headers_nil: boolean
					max_reconnect_attempts: number
					reconnect_delay_ms: number
					protocols_nil: boolean
					http_client_nil: boolean
				}
				kind_consts: string[]
			}

			expect(result.ws_name).toBe("ws")
			expect(result.sse_name).toBe("sse")
			expect(result.lp_name).toBe("longpoll")
			expect(result.ws_kind).toBe("ws")
			expect(result.sse_kind).toBe("sse")
			expect(result.lp_kind).toBe("longpoll")

			expect(result.opts_defaults.reconnect_token).toBe("")
			expect(result.opts_defaults.last_event_id).toBe("")
			expect(result.opts_defaults.headers_nil).toBe(true)
			expect(result.opts_defaults.max_reconnect_attempts).toBe(0)
			expect(result.opts_defaults.reconnect_delay_ms).toBe(0)
			expect(result.opts_defaults.protocols_nil).toBe(true)
			expect(result.opts_defaults.http_client_nil).toBe(true)

			expect(result.kind_consts).toEqual(["ws", "sse", "longpoll"])
		} finally {
			rmSync(dir, { force: true, recursive: true })
		}
	}, 60_000)

	it("Test 8.c.2 — ResumableConnection round-trips 2 events via custom Transport, closes cleanly", () => {
		const spec = loadMockSpec()
		const { files } = generateGoSDK(spec, { modulePath: "example.com/mock-sdk" })
		const dir = mkdtempSync(join(tmpdir(), "honey-go-harness-8c2-"))
		try {
			const sdkDir = join(dir, "sdk")
			mkdirSync(sdkDir, { recursive: true })
			for (const [filename, content] of Object.entries(files)) {
				const dest = join(sdkDir, filename)
				mkdirSync(join(dest, ".."), { recursive: true })
				writeFileSync(dest, content, "utf8")
			}

			/* in-process test: a failing adapter precedes a successful fake adapter;
			 * ResumableConnection falls through to the fake, streams two synthetic
			 * events, then closes cleanly. Mirrors Python 8.c.1 behavioral shape. */
			const mainGo = `package main

import (
	"context"
	"encoding/json"
	"fmt"
	"sync"
	"time"
	sdk "example.com/mock-sdk"
)

type failingAdapter struct{}

func (failingAdapter) Name() string                { return "fail" }
func (failingAdapter) Kind() sdk.TransportKind     { return sdk.TransportWs }
func (failingAdapter) Connect(ctx context.Context, url string, opts *sdk.TransportOpts) (sdk.TransportConn, error) {
	return nil, fmt.Errorf("boom")
}

type fakeConn struct {
	events []any
	idx    int
	mu     sync.Mutex
}

func (f *fakeConn) Kind() sdk.TransportKind { return sdk.TransportSse }
func (f *fakeConn) Recv(ctx context.Context) (any, error) {
	f.mu.Lock()
	if f.idx >= len(f.events) {
		f.mu.Unlock()
		<-ctx.Done()
		return nil, ctx.Err()
	}
	v := f.events[f.idx]
	f.idx++
	f.mu.Unlock()
	return v, nil
}
func (f *fakeConn) Send(ctx context.Context, data any) error { return nil }
func (f *fakeConn) Close() error                              { return nil }

type fakeAdapter struct{ calls int }

func (a *fakeAdapter) Name() string            { return "fake" }
func (a *fakeAdapter) Kind() sdk.TransportKind { return sdk.TransportSse }
func (a *fakeAdapter) Connect(ctx context.Context, url string, opts *sdk.TransportOpts) (sdk.TransportConn, error) {
	a.calls++
	return &fakeConn{events: []any{
		map[string]any{"seq": float64(1), "data": "hello"},
		map[string]any{"seq": float64(2), "data": "world"},
	}}, nil
}

func main() {
	fake := &fakeAdapter{}
	rc := sdk.NewResumableConnection(
		"http://test.local/rt",
		[]sdk.Transport{failingAdapter{}, fake},
		&sdk.TransportOpts{ReconnectToken: "rt-1", LastEventID: "42"},
	)
	initial := rc.State().String()

	if err := rc.Connect(context.Background()); err != nil {
		panic(err)
	}
	connected := rc.State().String()
	provenKind, provenOk := rc.ProvenTransport()

	events := []any{}
	timeout := time.After(3 * time.Second)
loop:
	for len(events) < 2 {
		select {
		case v, ok := <-rc.Events():
			if !ok {
				break loop
			}
			events = append(events, v)
		case <-timeout:
			panic("timed out waiting for events")
		}
	}

	_ = rc.Close()
	closedState := rc.State().String()

	out := map[string]any{
		"initial":       initial,
		"connected":     connected,
		"closed":        closedState,
		"proven_kind":   string(provenKind),
		"proven_ok":     provenOk,
		"connect_calls": fake.calls,
		"events":        events,
		"states": []string{
			sdk.StateConnecting.String(),
			sdk.StateConnected.String(),
			sdk.StateReconnecting.String(),
			sdk.StateDisconnected.String(),
		},
	}
	b, _ := json.Marshal(out)
	fmt.Println(string(b))
}
`
			writeFileSync(join(dir, "main.go"), mainGo, "utf8")

			const goMod = `module test-harness

go 1.23

require example.com/mock-sdk v0.0.0

replace example.com/mock-sdk => ./sdk
`
			writeFileSync(join(dir, "go.mod"), goMod, "utf8")

			try {
				execSync("go mod tidy", { cwd: dir, encoding: "utf8", timeout: 60_000 })
			} catch (err: unknown) {
				const e = err as { stderr?: string; stdout?: string; message?: string }
				throw new Error(
					`go mod tidy failed:\nstderr: ${e.stderr ?? ""}\nstdout: ${e.stdout ?? ""}\n${e.message ?? ""}`,
					{ cause: err },
				)
			}

			let stdout: string
			try {
				stdout = execSync("go run main.go", { cwd: dir, encoding: "utf8", timeout: 60_000 })
			} catch (err: unknown) {
				const e = err as { stderr?: string; stdout?: string; message?: string }
				throw new Error(
					`go run main.go failed:\nstderr: ${e.stderr ?? ""}\nstdout: ${e.stdout ?? ""}\n${e.message ?? ""}`,
					{ cause: err },
				)
			}

			const parsed = JSON.parse(stdout.trim()) as {
				initial: string
				connected: string
				closed: string
				proven_kind: string
				proven_ok: boolean
				connect_calls: number
				events: Array<Record<string, unknown>>
				states: string[]
			}

			expect(parsed.initial).toBe("disconnected")
			expect(parsed.connected).toBe("connected")
			expect(parsed.closed).toBe("disconnected")
			expect(parsed.proven_ok).toBe(true)
			expect(parsed.proven_kind).toBe("sse")
			expect(parsed.connect_calls).toBe(1)
			expect(parsed.events).toHaveLength(2)
			expect(parsed.events[0]?.seq).toBe(1)
			expect(parsed.events[1]?.seq).toBe(2)
			expect(parsed.states).toEqual(["connecting", "connected", "reconnecting", "disconnected"])
		} finally {
			rmSync(dir, { force: true, recursive: true })
		}
	}, 60_000)

	it("Test 8.d.1 — ResumableConnection drops mid-stream, reconnects via alternate Transport, resumes events", () => {
		const spec = loadMockSpec()
		const { files } = generateGoSDK(spec, { modulePath: "example.com/mock-sdk" })
		const dir = mkdtempSync(join(tmpdir(), "honey-go-harness-8d1-"))
		try {
			const sdkDir = join(dir, "sdk")
			mkdirSync(sdkDir, { recursive: true })
			for (const [filename, content] of Object.entries(files)) {
				const dest = join(sdkDir, filename)
				mkdirSync(join(dest, ".."), { recursive: true })
				writeFileSync(dest, content, "utf8")
			}

			/* In-process drop + reconnect: adapterA (flaky, WS-kind) yields 1 event
			 * then raises. ResumableConnection's readLoop invalidates proven, runs
			 * openChain; adapterA.Connect gets tried again in the new chain but its
			 * next conn also drops immediately; adapterB (stable, SSE-kind) then
			 * wins. Events drained: [A1, B1, B2] or [A1, <A-retry-drop>, B1, B2].
			 * Because Go readLoop retries proven=-1 → chain order → adapterA FIRST,
			 * the test uses a flakyAdapter that yields 1 event and then each
			 * subsequent Connect returns a pre-drained conn. Cleaner shape: every
			 * re-Connect of flaky returns a conn that immediately fails recv, so
			 * after 1st A event + drop, chain tries A again → fails → tries B → B
			 * wins on 2nd chain iteration. To keep the assertion simple, flaky's
			 * Connect returns the same conn type whose recv() errors immediately
			 * on any call after the first successful yield; chain attempt 2 fails
			 * on adapterA and falls to adapterB. */
			const mainGo = `package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sync"
	"time"
	sdk "example.com/mock-sdk"
)

type flakyConn struct {
	yielded bool
	mu      sync.Mutex
}

func (c *flakyConn) Kind() sdk.TransportKind { return sdk.TransportWs }
func (c *flakyConn) Recv(ctx context.Context) (any, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if !c.yielded {
		c.yielded = true
		return map[string]any{"src": "A", "seq": float64(1)}, nil
	}
	return nil, errors.New("simulated mid-stream drop")
}
func (c *flakyConn) Send(ctx context.Context, data any) error { return nil }
func (c *flakyConn) Close() error                              { return nil }

type flakyAdapter struct {
	mu       sync.Mutex
	calls    int
}

func (a *flakyAdapter) Name() string            { return "flaky-ws" }
func (a *flakyAdapter) Kind() sdk.TransportKind { return sdk.TransportWs }
func (a *flakyAdapter) Connect(ctx context.Context, url string, opts *sdk.TransportOpts) (sdk.TransportConn, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.calls++
	if a.calls == 1 {
		return &flakyConn{}, nil
	}
	/* retries after proven-invalidate immediately fail at connect so chain falls
	 * through to stable adapter deterministically. */
	return nil, fmt.Errorf("flaky adapter refuses reconnect")
}

type stableConn struct {
	events []any
	idx    int
	mu     sync.Mutex
}

func (c *stableConn) Kind() sdk.TransportKind { return sdk.TransportSse }
func (c *stableConn) Recv(ctx context.Context) (any, error) {
	c.mu.Lock()
	if c.idx >= len(c.events) {
		c.mu.Unlock()
		<-ctx.Done()
		return nil, ctx.Err()
	}
	v := c.events[c.idx]
	c.idx++
	c.mu.Unlock()
	return v, nil
}
func (c *stableConn) Send(ctx context.Context, data any) error { return nil }
func (c *stableConn) Close() error                              { return nil }

type stableAdapter struct {
	mu    sync.Mutex
	calls int
}

func (a *stableAdapter) Name() string            { return "stable-sse" }
func (a *stableAdapter) Kind() sdk.TransportKind { return sdk.TransportSse }
func (a *stableAdapter) Connect(ctx context.Context, url string, opts *sdk.TransportOpts) (sdk.TransportConn, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.calls++
	return &stableConn{events: []any{
		map[string]any{"src": "B", "seq": float64(1)},
		map[string]any{"src": "B", "seq": float64(2)},
	}}, nil
}

func main() {
	flaky := &flakyAdapter{}
	stable := &stableAdapter{}
	rc := sdk.NewResumableConnection(
		"http://test.local/rt",
		[]sdk.Transport{flaky, stable},
		&sdk.TransportOpts{ReconnectToken: "rt-1", LastEventID: "0", ReconnectDelayMs: 10},
	)
	if err := rc.Connect(context.Background()); err != nil {
		panic(err)
	}

	events := []any{}
	deadline := time.After(5 * time.Second)
loop:
	for len(events) < 3 {
		select {
		case v, ok := <-rc.Events():
			if !ok {
				break loop
			}
			events = append(events, v)
		case <-deadline:
			panic("timed out waiting for 3 events")
		}
	}

	flaky.mu.Lock()
	flakyCalls := flaky.calls
	flaky.mu.Unlock()
	stable.mu.Lock()
	stableCalls := stable.calls
	stable.mu.Unlock()

	provenKind, provenOk := rc.ProvenTransport()
	_ = rc.Close()
	closedState := rc.State().String()

	out := map[string]any{
		"events":        events,
		"flaky_calls":   flakyCalls,
		"stable_calls":  stableCalls,
		"proven_kind":   string(provenKind),
		"proven_ok":     provenOk,
		"closed_state":  closedState,
	}
	b, _ := json.Marshal(out)
	fmt.Println(string(b))
}
`
			writeFileSync(join(dir, "main.go"), mainGo, "utf8")

			const goMod = `module test-harness

go 1.23

require example.com/mock-sdk v0.0.0

replace example.com/mock-sdk => ./sdk
`
			writeFileSync(join(dir, "go.mod"), goMod, "utf8")

			try {
				execSync("go mod tidy", { cwd: dir, encoding: "utf8", timeout: 60_000 })
			} catch (err: unknown) {
				const e = err as { stderr?: string; stdout?: string; message?: string }
				throw new Error(
					`go mod tidy failed:\nstderr: ${e.stderr ?? ""}\nstdout: ${e.stdout ?? ""}\n${e.message ?? ""}`,
					{ cause: err },
				)
			}

			let stdout: string
			try {
				stdout = execSync("go run main.go", { cwd: dir, encoding: "utf8", timeout: 60_000 })
			} catch (err: unknown) {
				const e = err as { stderr?: string; stdout?: string; message?: string }
				throw new Error(
					`go run main.go failed:\nstderr: ${e.stderr ?? ""}\nstdout: ${e.stdout ?? ""}\n${e.message ?? ""}`,
					{ cause: err },
				)
			}

			const parsed = JSON.parse(stdout.trim()) as {
				events: Array<Record<string, unknown>>
				flaky_calls: number
				stable_calls: number
				proven_kind: string
				proven_ok: boolean
				closed_state: string
			}
			expect(parsed.events).toHaveLength(3)
			expect(parsed.events[0]).toEqual({ seq: 1, src: "A" })
			expect(parsed.events[1]).toEqual({ seq: 1, src: "B" })
			expect(parsed.events[2]).toEqual({ seq: 2, src: "B" })
			expect(parsed.flaky_calls).toBeGreaterThanOrEqual(1)
			expect(parsed.stable_calls).toBe(1)
			expect(parsed.proven_ok).toBe(true)
			expect(parsed.proven_kind).toBe("sse")
			expect(parsed.closed_state).toBe("disconnected")
		} finally {
			rmSync(dir, { force: true, recursive: true })
		}
	}, 60_000)

	it("Test 8.d.2 — ResumableConnection with a single custom Transport replaces default chain", () => {
		const spec = loadMockSpec()
		const { files } = generateGoSDK(spec, { modulePath: "example.com/mock-sdk" })
		const dir = mkdtempSync(join(tmpdir(), "honey-go-harness-8d2-"))
		try {
			const sdkDir = join(dir, "sdk")
			mkdirSync(sdkDir, { recursive: true })
			for (const [filename, content] of Object.entries(files)) {
				const dest = join(sdkDir, filename)
				mkdirSync(join(dest, ".."), { recursive: true })
				writeFileSync(dest, content, "utf8")
			}

			const mainGo = `package main

import (
	"context"
	"encoding/json"
	"fmt"
	"sync"
	"time"
	sdk "example.com/mock-sdk"
)

type customConn struct {
	events []any
	idx    int
	mu     sync.Mutex
}

func (c *customConn) Kind() sdk.TransportKind { return sdk.TransportWs }
func (c *customConn) Recv(ctx context.Context) (any, error) {
	c.mu.Lock()
	if c.idx >= len(c.events) {
		c.mu.Unlock()
		<-ctx.Done()
		return nil, ctx.Err()
	}
	v := c.events[c.idx]
	c.idx++
	c.mu.Unlock()
	return v, nil
}
func (c *customConn) Send(ctx context.Context, data any) error { return nil }
func (c *customConn) Close() error                              { return nil }

type customAdapter struct {
	mu    sync.Mutex
	calls int
}

func (a *customAdapter) Name() string            { return "custom" }
func (a *customAdapter) Kind() sdk.TransportKind { return sdk.TransportWs }
func (a *customAdapter) Connect(ctx context.Context, url string, opts *sdk.TransportOpts) (sdk.TransportConn, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.calls++
	return &customConn{events: []any{
		map[string]any{"kind": "custom", "seq": float64(1)},
		map[string]any{"kind": "custom", "seq": float64(2)},
	}}, nil
}

func main() {
	custom := &customAdapter{}
	rc := sdk.NewResumableConnection(
		"http://test.local/rt",
		[]sdk.Transport{custom},
		&sdk.TransportOpts{},
	)
	if err := rc.Connect(context.Background()); err != nil {
		panic(err)
	}
	connected := rc.State().String()
	provenKind, provenOk := rc.ProvenTransport()

	events := []any{}
	deadline := time.After(3 * time.Second)
loop:
	for len(events) < 2 {
		select {
		case v, ok := <-rc.Events():
			if !ok {
				break loop
			}
			events = append(events, v)
		case <-deadline:
			panic("timed out waiting for 2 events")
		}
	}

	custom.mu.Lock()
	customCalls := custom.calls
	custom.mu.Unlock()

	_ = rc.Close()
	closedState := rc.State().String()

	out := map[string]any{
		"events":       events,
		"custom_calls": customCalls,
		"connected":    connected,
		"proven_kind":  string(provenKind),
		"proven_ok":    provenOk,
		"closed_state": closedState,
	}
	b, _ := json.Marshal(out)
	fmt.Println(string(b))
}
`
			writeFileSync(join(dir, "main.go"), mainGo, "utf8")

			const goMod = `module test-harness

go 1.23

require example.com/mock-sdk v0.0.0

replace example.com/mock-sdk => ./sdk
`
			writeFileSync(join(dir, "go.mod"), goMod, "utf8")

			try {
				execSync("go mod tidy", { cwd: dir, encoding: "utf8", timeout: 60_000 })
			} catch (err: unknown) {
				const e = err as { stderr?: string; stdout?: string; message?: string }
				throw new Error(
					`go mod tidy failed:\nstderr: ${e.stderr ?? ""}\nstdout: ${e.stdout ?? ""}\n${e.message ?? ""}`,
					{ cause: err },
				)
			}

			let stdout: string
			try {
				stdout = execSync("go run main.go", { cwd: dir, encoding: "utf8", timeout: 60_000 })
			} catch (err: unknown) {
				const e = err as { stderr?: string; stdout?: string; message?: string }
				throw new Error(
					`go run main.go failed:\nstderr: ${e.stderr ?? ""}\nstdout: ${e.stdout ?? ""}\n${e.message ?? ""}`,
					{ cause: err },
				)
			}

			const parsed = JSON.parse(stdout.trim()) as {
				events: Array<Record<string, unknown>>
				custom_calls: number
				connected: string
				proven_kind: string
				proven_ok: boolean
				closed_state: string
			}
			expect(parsed.events).toHaveLength(2)
			expect(parsed.events[0]).toEqual({ kind: "custom", seq: 1 })
			expect(parsed.events[1]).toEqual({ kind: "custom", seq: 2 })
			expect(parsed.custom_calls).toBe(1)
			expect(parsed.connected).toBe("connected")
			expect(parsed.proven_ok).toBe(true)
			expect(parsed.proven_kind).toBe("ws")
			expect(parsed.closed_state).toBe("disconnected")
		} finally {
			rmSync(dir, { force: true, recursive: true })
		}
	}, 60_000)

	it("Test 9.a.4 — x-idempotency-key op auto-generates UUID, honors explicit field, headers win", async () => {
		const spec = loadMockSpec()
		const { files } = generateGoSDK(spec, { modulePath: "example.com/mock-sdk" })
		const dir = mkdtempSync(join(tmpdir(), "honey-go-harness-9a4-"))
		const { kill, port } = await startMockServerSubprocess()
		try {
			const sdkDir = join(dir, "sdk")
			mkdirSync(sdkDir, { recursive: true })
			for (const [filename, content] of Object.entries(files)) {
				const dest = join(sdkDir, filename)
				mkdirSync(join(dest, ".."), { recursive: true })
				writeFileSync(dest, content, "utf8")
			}

			const mainGo = `package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	sdk "example.com/mock-sdk"
)

type echoResp struct {
	IdempotencyKey string \`json:"idempotencyKey"\`
}

func decode(raw *json.RawMessage) string {
	var r echoResp
	if err := json.Unmarshal(*raw, &r); err != nil {
		panic(err)
	}
	return r.IdempotencyKey
}

func main() {
	client := sdk.NewClient(sdk.Config{BaseURL: os.Getenv("BASE_URL")})
	ctx := context.Background()
	auto, err := client.IdempotentCreate(ctx, nil)
	if err != nil {
		panic(err)
	}
	explicit, err := client.IdempotentCreate(ctx, &sdk.IdempotentCreateOpts{IdempotencyKey: "user-supplied-key-123"})
	if err != nil {
		panic(err)
	}
	headerWin, err := client.IdempotentCreate(ctx, &sdk.IdempotentCreateOpts{
		IdempotencyKey: "should-be-ignored",
		Headers:        map[string]string{"Idempotency-Key": "header-wins-key"},
	})
	if err != nil {
		panic(err)
	}
	out := map[string]string{
		"auto":      decode(auto),
		"explicit":  decode(explicit),
		"headerWin": decode(headerWin),
	}
	b, _ := json.Marshal(out)
	fmt.Println(string(b))
}
`
			writeFileSync(join(dir, "main.go"), mainGo, "utf8")

			const goMod = `module test-harness

go 1.23

require example.com/mock-sdk v0.0.0

replace example.com/mock-sdk => ./sdk
`
			writeFileSync(join(dir, "go.mod"), goMod, "utf8")

			try {
				execSync("go mod tidy", {
					cwd: dir,
					encoding: "utf8",
					env: { ...process.env, BASE_URL: `http://127.0.0.1:${port}` },
					timeout: 60_000,
				})
			} catch (err: unknown) {
				const e = err as { stderr?: string; stdout?: string; message?: string }
				throw new Error(
					`go mod tidy failed:\nstderr: ${e.stderr ?? ""}\nstdout: ${e.stdout ?? ""}\n${e.message ?? ""}`,
					{ cause: err },
				)
			}

			let stdout: string
			try {
				stdout = execSync("go run main.go", {
					cwd: dir,
					encoding: "utf8",
					env: { ...process.env, BASE_URL: `http://127.0.0.1:${port}` },
					timeout: 60_000,
				})
			} catch (err: unknown) {
				const e = err as { stderr?: string; stdout?: string; message?: string }
				throw new Error(
					`go run main.go failed:\nstderr: ${e.stderr ?? ""}\nstdout: ${e.stdout ?? ""}\n${e.message ?? ""}`,
					{ cause: err },
				)
			}

			const result = JSON.parse(stdout.trim()) as { auto: string; explicit: string; headerWin: string }
			/* UUID v4 strict regex: version nibble = 4, variant nibble ∈ {8,9,a,b}. */
			expect(result.auto).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
			expect(result.explicit).toBe("user-supplied-key-123")
			expect(result.headerWin).toBe("header-wins-key")
		} finally {
			kill()
			rmSync(dir, { force: true, recursive: true })
		}
	}, 60_000)

	/* ------------------------------------------------------------------
	 * Phase 10 — WebSocket behavioural audit (10.a.1)
	 * ------------------------------------------------------------------ */

	async function runGoWsCase(mainBody: string): Promise<unknown> {
		const spec = loadMockSpec()
		const { files } = generateGoSDK(spec, { modulePath: "example.com/mock-sdk" })
		const dir = mkdtempSync(join(tmpdir(), "honey-go-harness-ws-"))
		const { kill, port } = await startMockServerSubprocess()
		try {
			const sdkDir = join(dir, "sdk")
			mkdirSync(sdkDir, { recursive: true })
			for (const [filename, content] of Object.entries(files)) {
				const dest = join(sdkDir, filename)
				mkdirSync(join(dest, ".."), { recursive: true })
				writeFileSync(dest, content, "utf8")
			}

			writeFileSync(join(dir, "main.go"), mainBody, "utf8")
			const goMod = `module test-harness

go 1.23

require example.com/mock-sdk v0.0.0

replace example.com/mock-sdk => ./sdk
`
			writeFileSync(join(dir, "go.mod"), goMod, "utf8")

			execSync("go mod tidy", {
				cwd: dir,
				encoding: "utf8",
				env: { ...process.env, BASE_URL: `http://127.0.0.1:${port}` },
				timeout: 60_000,
			})

			const stdout = execSync("go run main.go", {
				cwd: dir,
				encoding: "utf8",
				env: { ...process.env, BASE_URL: `http://127.0.0.1:${port}` },
				timeout: 60_000,
			})
			return JSON.parse(stdout.trim())
		} finally {
			kill()
			rmSync(dir, { force: true, recursive: true })
		}
	}

	it("Test 10.a.1 WS-A — connect + send + recv echo", async () => {
		const mainGo = `package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	sdk "example.com/mock-sdk"
)

func main() {
	client := sdk.NewClient(sdk.Config{BaseURL: os.Getenv("BASE_URL")})
	ctx := context.Background()
	ws, err := client.ConnectWs(ctx, nil)
	if err != nil {
		panic(err)
	}
	if err := ws.Send(ctx, "hello"); err != nil {
		panic(err)
	}
	msg, err := ws.Read(ctx)
	if err != nil {
		panic(err)
	}
	_ = ws.Close(sdk.WSStatusNormalClosure, "done")
	out, _ := json.Marshal(map[string]interface{}{"received": string(msg)})
	fmt.Println(string(out))
}
`
		const result = (await runGoWsCase(mainGo)) as { received: string }
		expect(result.received).toBe("hello")
	}, 90_000)

	it("Test 10.a.1 WS-B — client-initiated close terminates connection", async () => {
		const mainGo = `package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	sdk "example.com/mock-sdk"
)

func main() {
	client := sdk.NewClient(sdk.Config{BaseURL: os.Getenv("BASE_URL")})
	ctx := context.Background()
	ws, err := client.ConnectWs(ctx, nil)
	if err != nil {
		panic(err)
	}
	if err := ws.Close(sdk.WSStatusNormalClosure, "client-bye"); err != nil {
		panic(err)
	}
	_, readErr := ws.Read(ctx)
	out, _ := json.Marshal(map[string]interface{}{
		"errNil":   readErr == nil,
		"errStr":   fmt.Sprintf("%v", readErr),
	})
	fmt.Println(string(out))
}
`
		const result = (await runGoWsCase(mainGo)) as { errNil: boolean; errStr: string }
		expect(result.errNil).toBe(false)
	}, 90_000)

	it("Test 10.a.1 WS-C — server-initiated close detected", async () => {
		const mainGo = `package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	sdk "example.com/mock-sdk"
	"nhooyr.io/websocket"
)

func main() {
	client := sdk.NewClient(sdk.Config{BaseURL: os.Getenv("BASE_URL")})
	ctx := context.Background()
	ws, err := client.ConnectWs(ctx, nil)
	if err != nil {
		panic(err)
	}
	if err := ws.Send(ctx, "__close__"); err != nil {
		panic(err)
	}
	_, readErr := ws.Read(ctx)
	var ce websocket.CloseError
	code := -1
	reason := ""
	if errors.As(readErr, &ce) {
		code = int(ce.Code)
		reason = ce.Reason
	}
	out, _ := json.Marshal(map[string]interface{}{
		"code":   code,
		"reason": reason,
	})
	fmt.Println(string(out))
}
`
		const result = (await runGoWsCase(mainGo)) as { code: number; reason: string }
		expect(result.code).toBe(1000)
		expect(result.reason).toBe("server-initiated")
	}, 90_000)

	it("Test 10.a.1 WS-D — auth handshake via ?token= query-param", async () => {
		const mainGo = `package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	sdk "example.com/mock-sdk"
	"nhooyr.io/websocket"
)

func runCase(client *sdk.Client, ctx context.Context, token string) map[string]interface{} {
	opts := &sdk.ConnectWsOpts{}
	t := token
	opts.Token = &t
	ws, err := client.ConnectWs(ctx, opts)
	if err != nil {
		return map[string]interface{}{"token": token, "dialErr": err.Error()}
	}
	if err := ws.Send(ctx, "ping"); err != nil {
		return map[string]interface{}{"token": token, "sendErr": err.Error()}
	}
	msg, readErr := ws.Read(ctx)
	echoed := ""
	code := -1
	if readErr == nil {
		echoed = string(msg)
		_ = ws.Close(sdk.WSStatusNormalClosure, "done")
	} else {
		var ce websocket.CloseError
		if errors.As(readErr, &ce) {
			code = int(ce.Code)
		}
	}
	return map[string]interface{}{"token": token, "echoed": echoed, "code": code}
}

func main() {
	client := sdk.NewClient(sdk.Config{BaseURL: os.Getenv("BASE_URL")})
	ctx := context.Background()
	ok := runCase(client, ctx, "valid-token")
	bad := runCase(client, ctx, "bogus-token")
	out, _ := json.Marshal(map[string]interface{}{"ok": ok, "bad": bad})
	fmt.Println(string(out))
}
`
		const result = (await runGoWsCase(mainGo)) as {
			ok: { echoed: string; code: number }
			bad: { echoed: string; code: number }
		}
		expect(result.ok.echoed).toBe("ping")
		expect(result.bad.echoed).toBe("")
		expect(result.bad.code).toBe(4401)
	}, 120_000)

	/* Ping/pong: auto-handled by nhooyr.io/websocket, not user-observable.
	 * Out of scope per master spec §11. BLOCKER if exposed later. */
	it.skip("Test 10.a.1 WS-E — ping/pong auto-handled (not user-observable)", () => {})
})
