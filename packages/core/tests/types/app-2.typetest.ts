import { describe, expectTypeOf, it } from "vitest"
import type { InferRouteMeta, MergeRoute } from "../../src/routing/app-types.ts"
import { honey } from "../../src/routing/app.ts"

type Chain10 = MergeRoute<
	MergeRoute<
		MergeRoute<
			MergeRoute<
				MergeRoute<
					MergeRoute<
						MergeRoute<
							MergeRoute<
								MergeRoute<MergeRoute<{}, "/r1", "GET", {}, { n: 1 }, unknown>, "/r2", "GET", {}, { n: 2 }, unknown>,
								"/r3",
								"GET",
								{},
								{ n: 3 },
								unknown
							>,
							"/r4",
							"GET",
							{},
							{ n: 4 },
							unknown
						>,
						"/r5",
						"GET",
						{},
						{ n: 5 },
						unknown
					>,
					"/r6",
					"GET",
					{},
					{ n: 6 },
					unknown
				>,
				"/r7",
				"GET",
				{},
				{ n: 7 },
				unknown
			>,
			"/r8",
			"GET",
			{},
			{ n: 8 },
			unknown
		>,
		"/r9",
		"GET",
		{},
		{ n: 9 },
		unknown
	>,
	"/r10",
	"GET",
	{},
	{ n: 10 },
	unknown
>

type Chain20 = MergeRoute<
	MergeRoute<
		MergeRoute<
			MergeRoute<
				MergeRoute<
					MergeRoute<
						MergeRoute<
							MergeRoute<
								MergeRoute<
									MergeRoute<Chain10, "/r11", "GET", {}, { n: 11 }, unknown>,
									"/r12",
									"GET",
									{},
									{ n: 12 },
									unknown
								>,
								"/r13",
								"GET",
								{},
								{ n: 13 },
								unknown
							>,
							"/r14",
							"GET",
							{},
							{ n: 14 },
							unknown
						>,
						"/r15",
						"GET",
						{},
						{ n: 15 },
						unknown
					>,
					"/r16",
					"GET",
					{},
					{ n: 16 },
					unknown
				>,
				"/r17",
				"GET",
				{},
				{ n: 17 },
				unknown
			>,
			"/r18",
			"GET",
			{},
			{ n: 18 },
			unknown
		>,
		"/r19",
		"GET",
		{},
		{ n: 19 },
		unknown
	>,
	"/r20",
	"GET",
	{},
	{ n: 20 },
	unknown
>

type Chain30 = MergeRoute<
	MergeRoute<
		MergeRoute<
			MergeRoute<
				MergeRoute<
					MergeRoute<
						MergeRoute<
							MergeRoute<
								MergeRoute<
									MergeRoute<Chain20, "/r21", "GET", {}, { n: 21 }, unknown>,
									"/r22",
									"GET",
									{},
									{ n: 22 },
									unknown
								>,
								"/r23",
								"GET",
								{},
								{ n: 23 },
								unknown
							>,
							"/r24",
							"GET",
							{},
							{ n: 24 },
							unknown
						>,
						"/r25",
						"GET",
						{},
						{ n: 25 },
						unknown
					>,
					"/r26",
					"GET",
					{},
					{ n: 26 },
					unknown
				>,
				"/r27",
				"GET",
				{},
				{ n: 27 },
				unknown
			>,
			"/r28",
			"GET",
			{},
			{ n: 28 },
			unknown
		>,
		"/r29",
		"GET",
		{},
		{ n: 29 },
		unknown
	>,
	"/r30",
	"GET",
	{},
	{ n: 30 },
	unknown
>

describe("MergeRoute depth: 10 routes", () => {
	// v0: 85569eeaad
	it("first route accessible", () => {
		expectTypeOf<Chain10["/r1"]["get"]["output"]>().toEqualTypeOf<{ n: 1 }>()
	})

	// v0: 6098a315b7
	it("last route accessible", () => {
		expectTypeOf<Chain10["/r10"]["get"]["output"]>().toEqualTypeOf<{ n: 10 }>()
	})

	// v0: ba3eadf318
	it("middle route accessible", () => {
		expectTypeOf<Chain10["/r5"]["get"]["output"]>().toEqualTypeOf<{ n: 5 }>()
	})
})

describe("MergeRoute depth: 20 routes", () => {
	// v0: 870a6969bc
	it("first route accessible", () => {
		expectTypeOf<Chain20["/r1"]["get"]["output"]>().toEqualTypeOf<{ n: 1 }>()
	})

	// v0: f4a4d8751a
	it("route 15 accessible", () => {
		expectTypeOf<Chain20["/r15"]["get"]["output"]>().toEqualTypeOf<{ n: 15 }>()
	})

	// v0: 316a2b15d7
	it("last route accessible", () => {
		expectTypeOf<Chain20["/r20"]["get"]["output"]>().toEqualTypeOf<{ n: 20 }>()
	})
})

describe("MergeRoute depth: 30 routes", () => {
	// v0: 25cca07c4b
	it("first route accessible", () => {
		expectTypeOf<Chain30["/r1"]["get"]["output"]>().toEqualTypeOf<{ n: 1 }>()
	})

	// v0: d4a541c2b8
	it("route 25 accessible", () => {
		expectTypeOf<Chain30["/r25"]["get"]["output"]>().toEqualTypeOf<{ n: 25 }>()
	})

	// v0: 506e0c6f5c
	it("last route accessible", () => {
		expectTypeOf<Chain30["/r30"]["get"]["output"]>().toEqualTypeOf<{ n: 30 }>()
	})
})

describe("MergeRoute same path different methods", () => {
	type Multi = MergeRoute<
		MergeRoute<
			MergeRoute<{}, "/users", "GET", {}, { list: true }, unknown>,
			"/users",
			"POST",
			{ json: { name: string } },
			{ created: true },
			unknown
		>,
		"/users",
		"DELETE",
		{},
		{ deleted: true },
		unknown
	>

	// v0: 626265f3f4
	it("GET method accessible", () => {
		expectTypeOf<Multi["/users"]["get"]["output"]>().toEqualTypeOf<{
			list: true
		}>()
	})

	// v0: de2ac9c5b7
	it("POST method accessible", () => {
		expectTypeOf<Multi["/users"]["post"]["output"]>().toEqualTypeOf<{
			created: true
		}>()
		expectTypeOf<Multi["/users"]["post"]["input"]>().toEqualTypeOf<{
			json: { name: string }
		}>()
	})

	// v0: 3ed539499b
	it("DELETE method accessible", () => {
		expectTypeOf<Multi["/users"]["delete"]["output"]>().toEqualTypeOf<{
			deleted: true
		}>()
	})
})

describe("meta preserved across routes", () => {
	// v0: 62fc72d2e4
	it("meta accessible on route with many predecessors", () => {
		const app = honey<{}>()
			.get("/r1")
			.handler((ctx) => ctx.res.text("ok", "1"))
			.get("/r2")
			.handler((ctx) => ctx.res.text("ok", "2"))
			.get("/r3")
			.handler((ctx) => ctx.res.text("ok", "3"))
			.get("/r4")
			.handler((ctx) => ctx.res.text("ok", "4"))
			.get("/r5")
			.handler((ctx) => ctx.res.text("ok", "5"))
			.get("/r6")
			.meta({ summary: "Route 6", tags: ["test"] })
			.handler((ctx) => ctx.res.text("ok", "6"))

		/* the route record carries its meta (MergeRoute) */
		type Meta = InferRouteMeta<typeof app, "/r6", "get">
		expectTypeOf<Meta>().toEqualTypeOf<{ summary: string; tags: string[] }>()
	})
})
