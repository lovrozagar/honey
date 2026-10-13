//#region src/utfUtil.ts
const isAscii = (codePoint) => codePoint <= 127;
const HIGH_SURROGATE_START = 55296;
const HIGH_SURROGATE_END = 56319;
function endsWithIncompleteUtfPairSurrogate(string) {
	if (string.length === 0) return false;
	const lastCharCode = string.charCodeAt(string.length - 1);
	return lastCharCode >= HIGH_SURROGATE_START && lastCharCode <= HIGH_SURROGATE_END;
}
function isValidUTF8(bytes) {
	let i = 0;
	while (i < bytes.length) {
		const byte1 = bytes[i];
		let numBytes = 0;
		let codePoint = 0;
		if (byte1 <= 127) {
			numBytes = 1;
			codePoint = byte1;
		} else if ((byte1 & 224) === 192) {
			numBytes = 2;
			codePoint = byte1 & 31;
			if (byte1 <= 193) return false;
		} else if ((byte1 & 240) === 224) {
			numBytes = 3;
			codePoint = byte1 & 15;
		} else if ((byte1 & 248) === 240) {
			numBytes = 4;
			codePoint = byte1 & 7;
			if (byte1 > 244) return false;
		} else return false;
		if (i + numBytes > bytes.length) return false;
		for (let j = 1; j < numBytes; j++) {
			const byte = bytes[i + j];
			if (byte === void 0 || (byte & 192) !== 128) return false;
			codePoint = codePoint << 6 | byte & 63;
		}
		if (numBytes === 2 && codePoint < 128) return false;
		if (numBytes === 3 && codePoint < 2048) return false;
		if (numBytes === 4 && codePoint < 65536) return false;
		if (codePoint >= 55296 && codePoint <= 57343) return false;
		if (codePoint > 1114111) return false;
		i += numBytes;
	}
	return true;
}
const textDecoder = new TextDecoder("utf8", { fatal: false });
function tryConvertToString(arr) {
	if (!isValidUTF8(arr)) return;
	return textDecoder.decode(arr);
}
function compareUint8Arrays(a, b) {
	const len = Math.min(a.length, b.length);
	for (let i = 0; i < len; i++) if (a[i] !== b[i]) return a[i] - b[i];
	return a.length - b.length;
}
//#endregion
export { compareUint8Arrays, endsWithIncompleteUtfPairSurrogate, isAscii, tryConvertToString };

//# sourceMappingURL=utfUtil.js.map