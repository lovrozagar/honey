import { describe, expect, it } from "vitest";
import { honey } from "../../../src/index.ts";
import { poweredBy } from "../../../src/powered-by.ts";

function makeApp(opts?: Parameters<typeof poweredBy>[0]) {
	const app = honey<{}>().use(poweredBy(opts));
	app.get("/test").handler((ctx) => ctx.res.json("ok", { ok: true }));
	return app;
}

describe("powered-by middleware", () => {
	it("default → X-Powered-By: Honey", async () => {
		const app = makeApp();
		const res = await app.fetch(new Request("http://localhost/test"), {});
		expect(res.headers.get("x-powered-by")).toBe("Honey");
	});

	it("custom name → X-Powered-By: MyFramework", async () => {
		const app = makeApp({ name: "MyFramework" });
		const res = await app.fetch(new Request("http://localhost/test"), {});
		expect(res.headers.get("x-powered-by")).toBe("MyFramework");
	});

	it("works on all HTTP methods", async () => {
		const app = honey<{}>().use(poweredBy());
		app.post("/submit").handler((ctx) => ctx.res.json("created", { id: 1 }));
		const res = await app.fetch(
			new Request("http://localhost/submit", { method: "POST" }),
			{},
		);
		expect(res.headers.get("x-powered-by")).toBe("Honey");
	});

	it("handler-set headers preserved", async () => {
		const app = honey<{}>().use(poweredBy());
		app
			.get("/custom")
			.handler((ctx) =>
				ctx.res.json("ok", {}, { headers: { "x-custom": "mine" } }),
			);
		const res = await app.fetch(new Request("http://localhost/custom"), {});
		expect(res.headers.get("x-custom")).toBe("mine");
		expect(res.headers.get("x-powered-by")).toBe("Honey");
	});
});
