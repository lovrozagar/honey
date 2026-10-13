import { EndOfPrompt, EndOfText, FimMiddle, FimPrefix, FimSuffix, ImEnd, ImSep, ImStart } from "../specialTokens.js";
import { CL100K_TOKEN_SPLIT_REGEX } from "./constants.js";
//#region src/encodingParams/cl100k_base.ts
function Cl100KBase(bytePairRankDecoder) {
	return {
		tokenSplitRegex: CL100K_TOKEN_SPLIT_REGEX,
		bytePairRankDecoder,
		specialTokensEncoder: /* @__PURE__ */ new Map([
			[EndOfText, 100257],
			[FimPrefix, 100258],
			[FimMiddle, 100259],
			[FimSuffix, 100260],
			[ImStart, 100264],
			[ImEnd, 100265],
			[ImSep, 100266],
			[EndOfPrompt, 100276]
		])
	};
}
//#endregion
export { Cl100KBase };

//# sourceMappingURL=cl100k_base.js.map