/**
 * Consumer programs: a `main` around a test's Go body, built and vetted beside the emitted SDK
 * (compileGo) and run, for what only compiling proves (a name, a type, a signature) or what a JSON
 * driver cannot fill. The program's client sends through an in-process recorder by default; with
 * `checkServed` the program reads `{base}` from stdin and may aim a client at a recording server.
 */
import { compileGo } from "./compiled.ts"

type Files = Readonly<Record<string, string>>

/**
 * A consumer program around `body`: `client(base)` is an SDK client over a recording transport,
 * which notes each request as `METHOD url[ x-trace=…][ body]` (query sorted) and answers it from
 * `replies` (`reply{status, body, headers}`, keyed `METHOD /path`; 200 `{}` by default, JSON unless
 * its headers say otherwise). `input.Base` is the `base` stdin carried, if any. It prints every
 * `section`'s notes as one JSON object. It imports BASE_IMPORTS and a program's own extra imports.
 */
const PROGRAM = `package main

import (
{{imports}}

	sdk "{{module}}"
)

type reply struct {
	status  int
	body    string
	headers map[string]string
}

var (
	ctx       = context.Background()
	replies   = map[string]reply{}
	out       = map[string][]string{}
	current   = "main"
	transport = &http.Client{Transport: recorder{}}
	input     struct {
		Base string \`json:"base"\`
	}
)

func section(name string) { current = name }

func note(parts ...any) { out[current] = append(out[current], strings.TrimSpace(fmt.Sprintln(parts...))) }

type recorder struct{}

func (recorder) RoundTrip(req *http.Request) (*http.Response, error) {
	line := req.Method + " " + req.URL.Scheme + "://" + req.URL.Host + req.URL.EscapedPath()
	if req.URL.RawQuery != "" {
		line += "?" + req.URL.Query().Encode()
	}
	if trace := req.Header.Get("X-Trace"); trace != "" {
		line += " x-trace=" + trace
	}
	if req.Body != nil {
		sent, _ := io.ReadAll(req.Body)
		if text := strings.TrimSpace(string(sent)); text != "" {
			line += " " + text
		}
	}
	note(line)
	answer, ok := replies[req.Method+" "+req.URL.Path]
	if !ok {
		answer = reply{status: 200, body: "{}"}
	}
	header := http.Header{"Content-Type": {"application/json"}}
	for name, value := range answer.headers {
		header.Set(name, value)
	}
	return &http.Response{
		Body:       io.NopCloser(strings.NewReader(answer.body)),
		Header:     header,
		Request:    req,
		StatusCode: answer.status,
	}, nil
}

func client(base string) *sdk.Client {
	return sdk.NewClient(sdk.Config{BaseURL: base, HTTPClient: transport})
}

func must[T any](v T, err error) T {
	if err != nil {
		note("error:", err)
	}
	return v
}

func main() {
	if err := json.NewDecoder(os.Stdin).Decode(&input); err != nil && err != io.EOF {
		fmt.Fprintln(os.Stderr, "input:", err)
		os.Exit(1)
	}
{{body}}
	if err := json.NewEncoder(os.Stdout).Encode(out); err != nil {
		os.Exit(1)
	}
}
`

/* the standard packages PROGRAM itself uses; Go rejects an unused import, so a body's own are opt-in */
const BASE_IMPORTS = ["context", "encoding/json", "fmt", "io", "net/http", "os", "strings"]

/** PROGRAM importing the SDK as `module` and the standard packages `imports` too, running `body`. */
export function program(module: string, body: string, imports: readonly string[] = []): string {
	const all = [...new Set([...BASE_IMPORTS, ...imports])].sort().map((path) => `\t"${path}"`)
	return PROGRAM.replace("{{imports}}", () => all.join("\n"))
		.replace("{{module}}", () => module)
		.replace("{{body}}", () => body)
}

/** A consumer program's build and run: whether it built, its vet findings, its notes by section. */
export type Run = { built: boolean; vet: readonly string[]; out: Record<string, string[]> | undefined; stderr: string }

/** The notes of a run, when it exited 0. */
const notesOf = (ran: { status: number; stdout: string }) =>
	ran.status === 0 ? (JSON.parse(ran.stdout) as Record<string, string[]>) : undefined

/** `files` built and vetted with the consumer `body` (importing `imports` too) beside them, which is run when it builds. */
export function check(files: Files, module: string, body: string, imports: readonly string[] = []): Run {
	const sdk = compileGo(files, { main: program(module, body, imports) })
	if (!sdk.built) return { built: false, out: undefined, stderr: sdk.stderr, vet: sdk.vet }
	const ran = sdk.run()
	return { built: true, out: notesOf(ran), stderr: ran.stderr, vet: sdk.vet }
}

/** `check` with `{base}` on stdin, run without blocking the event loop, so an in-process server can answer. */
export async function checkServed(files: Files, module: string, body: string, base: string): Promise<Run> {
	const sdk = compileGo(files, { main: program(module, body) })
	if (!sdk.built) return { built: false, out: undefined, stderr: sdk.stderr, vet: sdk.vet }
	const ran = await sdk.exec(JSON.stringify({ base }))
	return { built: true, out: notesOf(ran), stderr: ran.stderr, vet: sdk.vet }
}

/** `check` run once, on first use. */
export function once(run: () => Run): () => Run {
	let memo: Run | undefined
	return () => (memo ??= run())
}

/** What a test asserts of a run: it builds, vets clean, and the notes of `section`. */
export const seen = (run: Run, section = "main") => ({ built: run.built, out: run.out?.[section], vet: run.vet })
