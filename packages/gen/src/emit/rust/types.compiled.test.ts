/**
 * The emitted Rust types, compiled and run (contract 18 §8.3): the `types` registry crate builds as emitted,
 * and one consumer program over it decodes and encodes each mapping category through serde_json, one section
 * per category, so a shape that only text could show (tri-state, a reachable literal, an empty closed object,
 * a boxed cycle, a payload-keeping discriminator, raw identifiers, an integer enum, the extra flatten, unique
 * enum labels) is proven on the wire.
 */
import { describe, expect, it } from "vitest"
import { compiledRust } from "./__fixtures__/compiled.ts"
import { consume, once, seen } from "./__fixtures__/consumer.ts"
import { withRust } from "./__fixtures__/rust-env.ts"

/** Whether Rust is here: a missing toolchain fails where it is required and skips these legs elsewhere (rust-env). */
const RUST = withRust()

/* cargo builds the crate's dependencies on a cold cache */
const CARGO = 600_000

/* serde helpers the sections share: a decode with serde's error as text, an encode, a decode-then-encode */
const DECLS = `/// \`text\` decoded as a \`T\`, or serde's error as text.
fn de<T: serde::de::DeserializeOwned>(text: &str) -> Result<T, String> {
    serde_json::from_str(text).map_err(|e| e.to_string())
}

/// \`value\` as JSON text.
fn en<T: serde::Serialize>(value: &T) -> String {
    serde_json::to_string(value).unwrap_or_else(|e| format!("error: {e}"))
}

/// \`text\` decoded as a \`T\` and encoded again.
fn back<T: serde::Serialize + serde::de::DeserializeOwned>(text: &str) -> String {
    de::<T>(text).map(|v| en(&v)).unwrap_or_else(|e| format!("error: {e}"))
}

/// A decode's value in Debug form, or its error.
fn shown<T: std::fmt::Debug>(decoded: Result<T, String>) -> String {
    match decoded {
        Ok(v) => format!("{v:?}"),
        Err(e) => format!("error: {e}"),
    }
}

/// A \`Thing\` with only its required fields and the two tri-state ones set.
fn thing(note: Option<Option<String>>, x_key: Option<Option<i64>>) -> sdk::Thing {
    sdk::Thing { attrs: Default::default(), note, parent: None, plain: None, tags: Vec::new(), x_key }
}`

/* one section per §8.3 row; each notes what it decoded or encoded */
const BODY = `
    n.section("tri");
    for text in [r#"{"tags":[],"attrs":{},"note":null}"#, r#"{"tags":[],"attrs":{}}"#, r#"{"tags":[],"attrs":{},"note":"n","x-key":3}"#] {
        let line = match de::<sdk::Thing>(text) {
            Ok(t) => format!("note={:?} x_key={:?}", t.note, t.x_key),
            Err(e) => format!("error: {e}"),
        };
        n.note(line);
    }
    n.note(en(&thing(Some(None), Some(Some(3)))));
    n.note(en(&thing(None, None)));
    n.note(back::<sdk::Thing>(r#"{"attrs":{},"parent":null,"tags":[]}"#));
    n.note(back::<sdk::Thing>(r#"{"attrs":{},"parent":{"attrs":{},"tags":[]},"tags":[]}"#));

    n.section("mixed");
    for text in [r#""a""#, r#""b""#, "7"] {
        n.note(shown(de::<sdk::Mixed>(text)));
    }
    n.note(en(&sdk::Mixed::Literal(sdk::MixedLiteral::B)));
    n.note(en(&sdk::Mixed::Variant2(7)));

    n.section("closed");
    n.note(en(&sdk::X {}));
    n.note(back::<sdk::X>("{}"));

    n.section("cycle");
    n.note(back::<sdk::A>(r#"{"b":{"a":{}}}"#));
    n.note(en(&sdk::A { b: Some(Box::new(sdk::B { a: None })) }));

    n.section("animal");
    for text in [r#"{"kind":"dog","name":"rex"}"#, r#"{"kind":"cat","lives":9}"#, r#"{"kind":"bird"}"#] {
        let line = match de::<sdk::Animal>(text) {
            Ok(sdk::Animal::Dog(d)) => format!("Dog name={} kind={}", d.name.as_deref().unwrap_or("-"), d.kind),
            Ok(sdk::Animal::Cat(c)) => format!("Cat lives={:?} kind={}", c.lives, c.kind),
            Ok(sdk::Animal::Unknown(v)) => format!("Unknown {v}"),
            Err(e) => format!("error: {e}"),
        };
        n.note(line);
    }
    n.note(back::<sdk::Animal>(r#"{"kind":"dog","name":"rex"}"#));
    n.note(back::<sdk::Animal>(r#"{"kind":"bird"}"#));

    n.section("keywords");
    n.note(en(&sdk::Reserved { r#fn: "f".into(), r#match: "m".into(), r#type: "t".into() }));
    let line = match de::<sdk::Reserved>(r#"{"fn":"f","match":"m","type":"t"}"#) {
        Ok(r) => format!("{} {} {}", r.r#fn, r.r#match, r.r#type),
        Err(e) => format!("error: {e}"),
    };
    n.note(line);

    n.section("kind");
    n.note(en(&sdk::Kind::L2));
    n.note(shown(de::<sdk::Kind>("1")));
    n.note(shown(de::<sdk::Kind>("3")));
    n.note(format!("{:?} {}", sdk::Kind::default(), sdk::Kind::L2 as i64));

    n.section("extra");
    let line = match de::<sdk::Extra>(r#"{"id":"1","k":"v"}"#) {
        Ok(x) => format!("id={} extra={:?}", x.id, x.extra),
        Err(e) => format!("error: {e}"),
    };
    n.note(line);
    n.note(back::<sdk::Extra>(r#"{"id":"1","k":"v"}"#));

    n.section("labels");
    for text in [r#""""#, r#""self""#, r#""created_at""#] {
        n.note(shown(de::<sdk::QSort>(text)));
    }
    n.note(en(&sdk::QSort::CreatedAt));
    n.note(en(&sdk::QSort::CreatedAt2));
`.trim()

/** The `types` crate with the program beside it, built and run once for every section. */
const run = once(() => consume("types", "types", { body: BODY, decls: DECLS }))

/** Whether the program built, the notes of `section`, and its stderr, which a failure's diff shows. */
async function notes(section: string) {
	const ran = await run()
	return { ...seen(ran, section), stderr: ran.stderr }
}

/** What a section is expected to note: built, exactly `out`, any stderr. */
const noted = (out: readonly unknown[]) => ({ built: true, out, stderr: expect.any(String) })

describe.skipIf(!RUST)("emitted Rust structs on the wire: optional, nullable, empty, cyclic, keyword and open", () => {
	it(
		"builds the types crate as emitted, under --locked",
		() => {
			const sdk = compiledRust("types")
			expect(sdk.built, sdk.stderr).toBe(true)
		},
		CARGO,
	)

	// v0: 411e33be52
	// v0: 047b5225e0
	it(
		"keeps absent, null and a value apart on an optional nullable field, and omits an absent one",
		async () =>
			expect(await notes("tri")).toEqual(
				noted([
					"note=Some(None) x_key=None",
					"note=None x_key=None",
					'note=Some(Some("n")) x_key=Some(Some(3))',
					'{"attrs":{},"note":null,"tags":[],"x-key":3}',
					'{"attrs":{},"tags":[]}',
					'{"attrs":{},"parent":null,"tags":[]}',
					'{"attrs":{},"parent":{"attrs":{},"tags":[]},"tags":[]}',
				]),
			),
		CARGO,
	)

	/* V0BUG: v0 emitted the unit struct `X;`, which serde_json encodes as null and which rejects {}; `X {}` round-trips {} */
	// v0: 5a7811ce38
	it(
		"encodes and decodes a closed empty object as {}",
		async () => expect(await notes("closed")).toEqual(noted(["{}", "{}"])),
		CARGO,
	)

	// v0: fdac715f3f
	it(
		"round-trips a mutually recursive pair through its boxed fields",
		async () => expect(await notes("cycle")).toEqual(noted(['{"b":{"a":{}}}', '{"b":{}}'])),
		CARGO,
	)

	// v0: f265fd24a2
	it(
		"names keyword fields as raw identifiers that serialize under their JSON keys",
		async () => expect(await notes("keywords")).toEqual(noted(['{"fn":"f","match":"m","type":"t"}', "f m t"])),
		CARGO,
	)

	// v0: f902313a30
	it(
		"collects unnamed keys into the extra flatten and writes them back beside the named fields",
		async () => expect(await notes("extra")).toEqual(noted(['id=1 extra={"k": "v"}', '{"id":"1","k":"v"}'])),
		CARGO,
	)
})

describe.skipIf(!RUST)(
	"emitted Rust enums and unions on the wire: literals, discriminators, integers and labels",
	() => {
		// v0: 1f2d0b3088
		it(
			"decodes the const strings of a mixed union to its Literal variant and anything else to the rest",
			async () => expect(await notes("mixed")).toEqual(noted(["Literal(A)", "Literal(B)", "Variant2(7)", '"b"', "7"])),
			CARGO,
		)

		/* V0BUG: v0's #[serde(tag = "kind")] consumed the discriminator, so a variant's required kind failed to decode; dispatch keeps the payload whole */
		// v0: 2fda8aac06
		it(
			"dispatches a discriminated union on its kind, keeps kind in the payload, and keeps an unknown kind whole",
			async () =>
				expect(await notes("animal")).toEqual(
					noted([
						"Dog name=rex kind=dog",
						"Cat lives=Some(9) kind=cat",
						'Unknown {"kind":"bird"}',
						'{"kind":"dog","name":"rex"}',
						'{"kind":"bird"}',
					]),
				),
			CARGO,
		)

		// v0: 4b2edd336d
		it(
			"encodes an integer enum as its number, decodes a known one, rejects an unknown one, defaults to the first",
			async () =>
				expect(await notes("kind")).toEqual(noted(["2", "L1", expect.stringContaining("unknown Kind 3"), "L1 2"])),
			CARGO,
		)

		// v0: 784a6dbdf7
		it(
			"gives enum values that collide or are not identifiers unique variants that keep their wire value",
			async () =>
				expect(await notes("labels")).toEqual(
					noted(["Empty", "SelfValue", "CreatedAt2", '"-created_at"', '"created_at"']),
				),
			CARGO,
		)
	},
)
