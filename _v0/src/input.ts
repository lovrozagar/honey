export type ReadableStreamSchema<T> = {
	readonly _tag: "readableStream"
	readonly schema: T
}

export function readableStream<T>(schema: T): ReadableStreamSchema<T> {
	return { _tag: "readableStream", schema }
}
