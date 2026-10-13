import { EndOfPrompt, EndOfText, FimMiddle, FimPrefix, FimSuffix, ImEnd, ImSep, ImStart } from "../specialTokens.js";
import { O200K_TOKEN_SPLIT_REGEX } from "./constants.js";
//#region src/encodingParams/o200k_base.ts
const O200K_BASE_SPECIAL_TOKEN_ENTRIES = [
	[EndOfText, 199999],
	[FimPrefix, 2e5],
	[FimMiddle, 200001],
	[FimSuffix, 200002],
	[ImStart, 200003],
	[ImEnd, 200004],
	[ImSep, 200005],
	[EndOfPrompt, 200006]
];
const createO200KSpecialTokenMap = () => new Map(O200K_BASE_SPECIAL_TOKEN_ENTRIES);
function O200KBase(bytePairRankDecoder) {
	return {
		tokenSplitRegex: O200K_TOKEN_SPLIT_REGEX,
		bytePairRankDecoder,
		specialTokensEncoder: createO200KSpecialTokenMap()
	};
}
//#endregion
export { O200KBase, createO200KSpecialTokenMap };

//# sourceMappingURL=o200k_base.js.map