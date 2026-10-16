/**
 * Consumer programs (contract 18 §7.3): a `main` around a test's Rust body, built as a bin in a copy of a
 * registry SDK's crate (compiledRust, Fb6) and run, for what only compiling proves (a name, a type, a
 * signature) or what a JSON driver cannot fill. The program reads `{base}` from stdin, so a body may aim a
 * client at the shared recording server (`served()`, emit/shared/__fixtures__/recording-server.ts), and
 * prints every section's notes as one JSON object. A body's own `use` imports and top-level declarations
 * are opt-in.
 */
import { compiledRust } from "./compiled.ts"
import type { FixtureKey } from "./documents.ts"

/**
 * The program around `{{body}}`: `n.section(s)` starts a section, `n.note(line)` adds to it, `client(base)`
 * is an SDK client aimed at `base`, which is `input["base"]` (an unroutable address without one).
 */
const PROGRAM = `#![allow(unused)] // a test program, never shipped
use std::collections::BTreeMap;
{{imports}}
struct Notes {
    at: String,
    out: BTreeMap<String, Vec<String>>,
}

impl Notes {
    fn section(&mut self, s: &str) {
        self.at = s.into();
    }

    fn note(&mut self, line: impl Into<String>) {
        self.out.entry(self.at.clone()).or_default().push(line.into());
    }
}

fn client(base: &str) -> Result<sdk::Client, sdk::Error> {
    sdk::Client::new(sdk::ClientConfig { base_url: base.into(), ..Default::default() })
}

#[tokio::main(flavor = "current_thread")]
async fn main() {
    let input: serde_json::Value = serde_json::from_reader(std::io::stdin()).unwrap_or(serde_json::Value::Null);
    let base = input["base"].as_str().unwrap_or("http://127.0.0.1:9").to_owned();
    let mut n = Notes { at: "main".into(), out: BTreeMap::new() };
    {{body}}
    println!("{}", serde_json::to_string(&n.out).expect("notes"));
}
{{decls}}`

/** A consumer program: its body, the paths it `use`s, its top-level declarations, the base on its stdin. */
export type Consumer = {
	readonly base?: string
	readonly body: string
	readonly decls?: string
	readonly imports?: readonly string[]
}

/** A consumer program's build and run: whether it built, its notes by section, its stderr. */
export type Run = { built: boolean; out: Record<string, string[]> | undefined; stderr: string }

/** PROGRAM around `p`'s body, with its imports and declarations. */
export function program(p: Consumer): string {
	const imports = [...new Set(p.imports ?? [])].sort().map((path) => `use ${path};\n`)
	return PROGRAM.replace("{{imports}}", () => imports.join(""))
		.replace("{{body}}", () => p.body)
		.replace("{{decls}}", () => (p.decls === undefined ? "" : `\n${p.decls}\n`))
}

/**
 * The registry SDK `key` built with the consumer `p` beside it as bin `name`, run with `{base}` on stdin
 * without blocking the event loop.
 */
export async function consume(key: FixtureKey, name: string, p: Consumer): Promise<Run> {
	const sdk = compiledRust(key, { programs: { [name]: program(p) } })
	if (!sdk.built) return { built: false, out: undefined, stderr: sdk.stderr }
	const ran = await sdk.exec(name, JSON.stringify(p.base === undefined ? {} : { base: p.base }))
	const out = ran.status === 0 ? (JSON.parse(ran.stdout) as Record<string, string[]>) : undefined
	return { built: true, out, stderr: ran.stderr }
}

/** `run` run once, on first use. */
export function once<T>(run: () => Promise<T>): () => Promise<T> {
	let memo: Promise<T> | undefined
	return () => (memo ??= run())
}

/** What a test asserts of a run: it builds, and the notes of `section`. */
export const seen = (run: Run, section = "main") => ({ built: run.built, out: run.out?.[section] })

/** The async fn that runs section `name`, its `-` as `_`; a name that does not then make a Rust identifier is refused. */
function sectionFn(name: string): string {
	const ident = name.replaceAll("-", "_")
	if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(ident))
		throw new Error(`a section name must be a Rust identifier once its "-" are "_": ${JSON.stringify(name)}`)
	return `${ident}_section`
}

/**
 * A program body running each of `fns` (a section's Rust statements) as an async fn of its own, in order, each
 * an `Err` noted in its section: spread into `consume`'s program as its `body` and `decls`.
 */
export function sections(fns: Readonly<Record<string, string>>): { body: string; decls: string } {
	const body = Object.keys(fns)
		.map((s) => `n.section("${s}");\n    let r = ${sectionFn(s)}(&mut n, &base).await;\n    done(&mut n, r);`)
		.join("\n    ")
	const decls = Object.entries(fns).map(
		([s, text]) =>
			`async fn ${sectionFn(s)}(n: &mut Notes, base: &str) -> Result<(), sdk::Error> {\n${text}\n    Ok(())\n}`,
	)
	const done = `fn done(n: &mut Notes, r: Result<(), sdk::Error>) {\n    if let Err(e) = r {\n        n.note(format!("error {e}"));\n    }\n}`
	return { body, decls: [done, ...decls].join("\n\n") }
}
