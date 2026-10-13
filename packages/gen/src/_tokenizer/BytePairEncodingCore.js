import { DEFAULT_MERGE_CACHE_SIZE } from "./constants.js";
import { compareUint8Arrays, isAscii, tryConvertToString } from "./utfUtil.js";
import { escapeRegExp } from "./util.js";
//#region src/BytePairEncodingCore.ts
const emptyBuffer = /* @__PURE__ */ new Uint8Array(0);
const decoder = new TextDecoder("utf8");
var BytePairEncodingCore = class {
	mergeableBytePairRankCount;
	/**
	* an array where the index is the BPE rank,
	* and the value is the string or the array of bytes that it decodes to
	* it may contain holes if token is unused
	*/
	bytePairRankDecoder;
	bytePairNonUtfRankDecoder = /* @__PURE__ */ new Map();
	bytePairNonUtfSortedEncoder;
	/**
	* a reverse map of the bytePairRankDecoder,
	* where the key is the string and the value is the rank
	* values that cannot be represented as a string are present in `bytePairNonUtfSortedEncoder`
	*/
	bytePairStringRankEncoder;
	tokenSplitRegex;
	specialTokensEncoder;
	specialTokensDecoder;
	specialTokenPatternRegex;
	textEncoder = new TextEncoder();
	mergeCache;
	mergeCacheSize;
	constructor({ bytePairRankDecoder, specialTokensEncoder, tokenSplitRegex, mergeCacheSize = DEFAULT_MERGE_CACHE_SIZE }) {
		this.bytePairRankDecoder = bytePairRankDecoder;
		this.bytePairStringRankEncoder = /* @__PURE__ */ new Map();
		this.mergeCacheSize = mergeCacheSize;
		if (mergeCacheSize > 0) this.mergeCache = /* @__PURE__ */ new Map();
		this.mergeableBytePairRankCount = Object.keys(bytePairRankDecoder).length;
		const binaryLookup = [];
		bytePairRankDecoder.forEach((value, rank) => {
			if (typeof value === "string") {
				this.bytePairStringRankEncoder.set(value, rank);
				return;
			}
			const byteArray = new Uint8Array(value);
			binaryLookup.push([byteArray, rank]);
			this.bytePairNonUtfRankDecoder.set(rank, byteArray);
		});
		this.bytePairNonUtfSortedEncoder = binaryLookup.sort((a, b) => compareUint8Arrays(a[0], b[0]));
		this.specialTokensEncoder = specialTokensEncoder ?? /* @__PURE__ */ new Map();
		this.specialTokensDecoder = specialTokensEncoder ? new Map([...specialTokensEncoder].map(([key, value]) => [value, key])) : /* @__PURE__ */ new Map();
		this.tokenSplitRegex = tokenSplitRegex;
		const allSpecialTokensRegex = [...this.specialTokensEncoder.keys()].map(escapeRegExp).join("|");
		try {
			this.specialTokenPatternRegex = new RegExp(allSpecialTokensRegex, "y");
		} catch {
			throw new Error("Invalid regular expression pattern.");
		}
	}
	setMergeCacheSize(newSize) {
		if (this.mergeCacheSize === 0 && newSize > 0) this.mergeCache = /* @__PURE__ */ new Map();
		this.mergeCacheSize = newSize;
		if (newSize === 0) this.mergeCache = void 0;
	}
	clearMergeCache() {
		this.mergeCache?.clear();
	}
	*encodeNativeGenerator(text, allowedSpecial) {
		let startIndex = 0;
		let lastTokenLength = 0;
		while (true) {
			const nextSpecialMatch = this.findNextSpecialToken(text, allowedSpecial, startIndex);
			const nextSpecialStartIndex = nextSpecialMatch?.[0];
			const endIndex = nextSpecialStartIndex ?? text.length;
			const textBeforeSpecial = startIndex === 0 && endIndex === text.length ? text : text.slice(startIndex, endIndex);
			for (const [match] of textBeforeSpecial.matchAll(this.tokenSplitRegex)) {
				const token = this.getBpeRankFromString(match);
				if (token !== void 0) {
					lastTokenLength = 1;
					yield [token];
					continue;
				}
				const tokens = this.bytePairEncode(match);
				lastTokenLength = tokens.length;
				yield tokens;
			}
			if (nextSpecialStartIndex !== void 0) {
				const specialToken = nextSpecialMatch[1];
				const specialTokenValue = this.specialTokensEncoder.get(specialToken);
				if (specialTokenValue === void 0) throw new Error(`Special token "${specialToken}" is not in the special token encoder.`);
				yield [specialTokenValue];
				startIndex = nextSpecialStartIndex + specialToken.length;
				lastTokenLength = 1;
			} else break;
		}
		return lastTokenLength;
	}
	encodeNative(text, allowedSpecial) {
		let startIndex = 0;
		const tokensArray = [];
		while (true) {
			const nextSpecialMatch = this.findNextSpecialToken(text, allowedSpecial, startIndex);
			const nextSpecialStartIndex = nextSpecialMatch?.[0];
			const endIndex = nextSpecialStartIndex ?? text.length;
			const textBeforeSpecial = startIndex === 0 && endIndex === text.length ? text : text.slice(startIndex, endIndex);
			for (const [match] of textBeforeSpecial.matchAll(this.tokenSplitRegex)) {
				const token = this.getBpeRankFromString(match);
				if (token !== void 0) {
					tokensArray.push(token);
					continue;
				}
				const tokens = this.bytePairEncode(match);
				tokensArray.push(...tokens);
			}
			if (nextSpecialStartIndex !== void 0) {
				const specialToken = nextSpecialMatch[1];
				const specialTokenValue = this.specialTokensEncoder.get(specialToken);
				if (specialTokenValue === void 0) throw new Error(`Special token "${specialToken}" is not in the special token encoder.`);
				tokensArray.push(specialTokenValue);
				startIndex = nextSpecialStartIndex + specialToken.length;
			} else break;
		}
		return tokensArray;
	}
	countNative(text, allowedSpecial) {
		let startIndex = 0;
		let tokensCount = 0;
		while (true) {
			const nextSpecialMatch = this.findNextSpecialToken(text, allowedSpecial, startIndex);
			const nextSpecialStartIndex = nextSpecialMatch?.[0];
			const endIndex = nextSpecialStartIndex ?? text.length;
			const textBeforeSpecial = startIndex === 0 && endIndex === text.length ? text : text.slice(startIndex, endIndex);
			for (const [match] of textBeforeSpecial.matchAll(this.tokenSplitRegex)) {
				if (this.getBpeRankFromString(match) !== void 0) {
					tokensCount++;
					continue;
				}
				const tokens = this.bytePairEncode(match);
				tokensCount += tokens.length;
			}
			if (nextSpecialStartIndex !== void 0) {
				const specialToken = nextSpecialMatch[1];
				if (this.specialTokensEncoder.get(specialToken) === void 0) throw new Error(`Special token "${specialToken}" is not in the special token encoder.`);
				tokensCount++;
				startIndex = nextSpecialStartIndex + specialToken.length;
			} else break;
		}
		return tokensCount;
	}
	*decodeNativeGenerator(tokens) {
		for (const token of tokens) {
			const tokenBytes = this.tryDecodeToken(token);
			if (tokenBytes) yield tokenBytes;
		}
	}
	decodeNative(tokens) {
		let decoded = "";
		let intBuffer = emptyBuffer;
		for (const token of tokens) {
			const tokenBytes = this.tryDecodeToken(token);
			if (tokenBytes === void 0) throw new Error(`Token ${token} is not in the byte pair encoder.`);
			if (typeof tokenBytes === "string") {
				if (intBuffer !== emptyBuffer) {
					decoded += decoder.decode(intBuffer, { stream: true });
					intBuffer = emptyBuffer;
				}
				decoded += tokenBytes;
			} else {
				const newBuffer = new Uint8Array(intBuffer.length + tokenBytes.length);
				newBuffer.set(intBuffer);
				newBuffer.set(tokenBytes, intBuffer.length);
				intBuffer = newBuffer;
			}
		}
		if (intBuffer !== emptyBuffer) decoded += decoder.decode(intBuffer, { stream: true });
		return decoded;
	}
	async *decodeNativeAsyncIterable(tokens) {
		for await (const token of tokens) {
			const tokenBytesOrString = this.tryDecodeToken(token);
			if (tokenBytesOrString) yield tokenBytesOrString;
		}
	}
	getBpeRankFromString(key) {
		return this.bytePairStringRankEncoder.get(key);
	}
	getBpeRankFromStringOrThrow(key) {
		const value = this.getBpeRankFromString(key);
		if (value === void 0) throw new Error(`The byte-pair encoding does not contain a value for: ${key}`);
		return value;
	}
	getBpeRankFromBytes(key) {
		const keyAsString = tryConvertToString(key);
		if (keyAsString !== void 0) return this.getBpeRankFromString(keyAsString);
		const index = this.binarySearch(key);
		if (index !== -1) return this.bytePairNonUtfSortedEncoder[index][1];
	}
	getBpeRankFromBytesOrThrow(key) {
		const value = this.getBpeRankFromBytes(key);
		if (value === void 0) throw new Error(`The byte-pair encoding does not contain a value for: ${key.toString()}`);
		return value;
	}
	binarySearch(key) {
		let low = 0;
		let high = this.bytePairNonUtfSortedEncoder.length - 1;
		while (low <= high) {
			const mid = low + high >>> 1;
			const midKey = this.bytePairNonUtfSortedEncoder[mid][0];
			let cmp = 0;
			const maxLength = Math.min(midKey.length, key.length);
			for (let i = 0; i < maxLength; i++) {
				cmp = midKey[i] - key[i];
				if (cmp !== 0) break;
			}
			if (cmp === 0) cmp = midKey.length - key.length;
			if (cmp === 0) return mid;
			if (cmp < 0) low = mid + 1;
			else high = mid - 1;
		}
		return -1;
	}
	findNextSpecialToken(text, allowedSpecial, startIndex) {
		let searchIndex = startIndex;
		while (true) {
			this.specialTokenPatternRegex.lastIndex = searchIndex;
			const nextSpecialMatch = this.specialTokenPatternRegex.exec(text);
			if (!nextSpecialMatch) return;
			const specialToken = nextSpecialMatch[0];
			if (allowedSpecial?.has(specialToken)) return [nextSpecialMatch.index + searchIndex, specialToken];
			searchIndex = nextSpecialMatch.index + searchIndex + 1;
		}
	}
	tryDecodeToken(tokenRank) {
		const value = this.bytePairRankDecoder[tokenRank];
		if (typeof value === "string") return value;
		if (typeof value === "object") {
			const fromBinary = this.bytePairNonUtfRankDecoder.get(tokenRank);
			if (fromBinary) return fromBinary;
		}
		return this.specialTokensDecoder.get(tokenRank);
	}
	addToMergeCache(key, value) {
		if (!this.mergeCache) return;
		if (this.mergeCache.size >= this.mergeCacheSize) {
			const firstKey = this.mergeCache.keys().next().value;
			this.mergeCache.delete(firstKey);
		}
		this.mergeCache.set(key, value);
	}
	bytePairEncode(input) {
		if (input.length === 1 && isAscii(input.codePointAt(0))) return [this.getBpeRankFromStringOrThrow(input)];
		if (this.mergeCache?.has(input)) {
			const result = this.mergeCache.get(input);
			this.mergeCache.delete(input);
			this.mergeCache.set(input, result);
			return result;
		}
		const inputBytes = this.textEncoder.encode(input);
		const result = this.bytePairMerge(inputBytes);
		this.addToMergeCache(input, result);
		return result;
	}
	bytePairMerge(piece) {
		const starts = [];
		const ranks = [];
		const getRank = (startIndex, pairStart = starts[startIndex], pairEnd = starts[startIndex + 2]) => {
			if (pairEnd === void 0) return Number.POSITIVE_INFINITY;
			const key = piece.subarray(pairStart, pairEnd);
			return this.getBpeRankFromBytes(key) ?? Number.POSITIVE_INFINITY;
		};
		for (let i = 0; i <= piece.length; i++) {
			starts.push(i);
			if (i < piece.length - 1) ranks.push(getRank(i, i, i + 2));
			else ranks.push(Number.POSITIVE_INFINITY);
		}
		while (starts.length > 1) {
			let lowestRank = Number.POSITIVE_INFINITY;
			let lowestPartitionIndex = -1;
			for (let i = 0; i < ranks.length - 1; i++) {
				const rank = ranks[i];
				if (rank < lowestRank) {
					lowestRank = rank;
					lowestPartitionIndex = i;
				}
			}
			if (lowestRank === Number.POSITIVE_INFINITY || lowestPartitionIndex === -1) break;
			starts.splice(lowestPartitionIndex + 1, 1);
			ranks.splice(lowestPartitionIndex, 1);
			ranks[lowestPartitionIndex] = getRank(lowestPartitionIndex);
			if (lowestPartitionIndex > 0) ranks[lowestPartitionIndex - 1] = getRank(lowestPartitionIndex - 1);
		}
		const output = [];
		for (let i = 0; i < starts.length - 1; i++) {
			const pairStart = starts[i];
			const pairEnd = starts[i + 1];
			const bpeValue = this.getBpeRankFromBytesOrThrow(piece.subarray(pairStart, pairEnd));
			output.push(bpeValue);
		}
		return output;
	}
};
//#endregion
export { BytePairEncodingCore, decoder };

//# sourceMappingURL=BytePairEncodingCore.js.map