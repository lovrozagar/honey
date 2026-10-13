//#region src/utfUtil.d.ts
declare const isAscii: (codePoint: number) => boolean;
declare function endsWithIncompleteUtfPairSurrogate(string: string): boolean;
declare function tryConvertToString(arr: Uint8Array): string | undefined;
declare function compareUint8Arrays(a: Uint8Array, b: Uint8Array): number;
//#endregion
export { compareUint8Arrays, endsWithIncompleteUtfPairSurrogate, isAscii, tryConvertToString };
//# sourceMappingURL=utfUtil.d.ts.map