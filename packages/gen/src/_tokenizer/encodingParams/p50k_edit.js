import { EndOfText, FimMiddle, FimPrefix, FimSuffix } from "../specialTokens.js";
import { R50K_TOKEN_SPLIT_REGEX } from "./constants.js";
import "../modelParams.js";
//#region src/encodingParams/p50k_edit.ts
function P50KEdit(bytePairRankDecoder) {
	return {
		tokenSplitRegex: R50K_TOKEN_SPLIT_REGEX,
		bytePairRankDecoder,
		specialTokensEncoder: /* @__PURE__ */ new Map([
			[EndOfText, 50256],
			[FimPrefix, 50281],
			[FimMiddle, 50282],
			[FimSuffix, 50283]
		])
	};
}
//#endregion
export { P50KEdit };

//# sourceMappingURL=p50k_edit.js.map