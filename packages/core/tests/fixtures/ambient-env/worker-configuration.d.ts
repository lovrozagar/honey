/* ambient script shaped like `wrangler types` output; R2 declarations copied verbatim from it */
declare namespace Cloudflare {
	interface Env {
		BUCKET: R2Bucket
	}
}
interface R2ListOptions {
	limit?: number
	prefix?: string
	cursor?: string
	delimiter?: string
	startAfter?: string
	include?: ("httpMetadata" | "customMetadata")[]
}
interface R2Bucket {
	head(key: string): Promise<R2Object | null>
	get(
		key: string,
		options: R2GetOptions & {
			onlyIf: R2Conditional | Headers
		},
	): Promise<R2ObjectBody | R2Object | null>
	get(key: string, options?: R2GetOptions): Promise<R2ObjectBody | null>
	put(
		key: string,
		value: ReadableStream | ArrayBuffer | ArrayBufferView | string | null | Blob,
		options?: R2PutOptions & {
			onlyIf: R2Conditional | Headers
		},
	): Promise<R2Object | null>
	put(
		key: string,
		value: ReadableStream | ArrayBuffer | ArrayBufferView | string | null | Blob,
		options?: R2PutOptions,
	): Promise<R2Object>
	createMultipartUpload(key: string, options?: R2MultipartOptions): Promise<R2MultipartUpload>
	resumeMultipartUpload(key: string, uploadId: string): R2MultipartUpload
	delete(keys: string | string[]): Promise<void>
	list(options?: R2ListOptions): Promise<R2Objects>
}
interface R2MultipartUpload {
	readonly key: string
	readonly uploadId: string
	uploadPart(
		partNumber: number,
		value: ReadableStream | (ArrayBuffer | ArrayBufferView) | string | Blob,
		options?: R2UploadPartOptions,
	): Promise<R2UploadedPart>
	abort(): Promise<void>
	complete(uploadedParts: R2UploadedPart[]): Promise<R2Object>
}
interface R2UploadedPart {
	partNumber: number
	etag: string
}
declare abstract class R2Object {
	readonly key: string
	readonly version: string
	readonly size: number
	readonly etag: string
	readonly httpEtag: string
	readonly checksums: R2Checksums
	readonly uploaded: Date
	readonly httpMetadata?: R2HTTPMetadata
	readonly customMetadata?: Record<string, string>
	readonly range?: R2Range
	readonly storageClass: string
	readonly ssecKeyMd5?: string
	writeHttpMetadata(headers: Headers): void
}
interface R2ObjectBody extends R2Object {
	get body(): ReadableStream
	get bodyUsed(): boolean
	arrayBuffer(): Promise<ArrayBuffer>
	bytes(): Promise<Uint8Array>
	text(): Promise<string>
	json<T>(): Promise<T>
	blob(): Promise<Blob>
}
type R2Range =
	| {
			offset: number
			length?: number
	  }
	| {
			offset?: number
			length: number
	  }
	| {
			suffix: number
	  }
interface R2Conditional {
	etagMatches?: string
	etagDoesNotMatch?: string
	uploadedBefore?: Date
	uploadedAfter?: Date
	secondsGranularity?: boolean
}
interface R2GetOptions {
	onlyIf?: R2Conditional | Headers
	range?: R2Range | Headers
	ssecKey?: ArrayBuffer | string
}
interface R2PutOptions {
	onlyIf?: R2Conditional | Headers
	httpMetadata?: R2HTTPMetadata | Headers
	customMetadata?: Record<string, string>
	md5?: (ArrayBuffer | ArrayBufferView) | string
	sha1?: (ArrayBuffer | ArrayBufferView) | string
	sha256?: (ArrayBuffer | ArrayBufferView) | string
	sha384?: (ArrayBuffer | ArrayBufferView) | string
	sha512?: (ArrayBuffer | ArrayBufferView) | string
	storageClass?: string
	ssecKey?: ArrayBuffer | string
}
interface R2MultipartOptions {
	httpMetadata?: R2HTTPMetadata | Headers
	customMetadata?: Record<string, string>
	storageClass?: string
	ssecKey?: ArrayBuffer | string
}
interface R2Checksums {
	readonly md5?: ArrayBuffer
	readonly sha1?: ArrayBuffer
	readonly sha256?: ArrayBuffer
	readonly sha384?: ArrayBuffer
	readonly sha512?: ArrayBuffer
	toJSON(): R2StringChecksums
}
interface R2StringChecksums {
	md5?: string
	sha1?: string
	sha256?: string
	sha384?: string
	sha512?: string
}
interface R2HTTPMetadata {
	contentType?: string
	contentLanguage?: string
	contentDisposition?: string
	contentEncoding?: string
	cacheControl?: string
	cacheExpiry?: Date
}
type R2Objects = {
	objects: R2Object[]
	delimitedPrefixes: string[]
} & (
	| {
			truncated: true
			cursor: string
	  }
	| {
			truncated: false
	  }
)
interface R2UploadPartOptions {
	ssecKey?: ArrayBuffer | string
}
