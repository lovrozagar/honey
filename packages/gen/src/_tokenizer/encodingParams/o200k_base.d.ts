import { RawBytePairRanks } from "../BytePairEncodingCore.js";
import { EncodingParams } from "../modelParams.js";
//#region src/encodingParams/o200k_base.d.ts
declare const createO200KSpecialTokenMap: () => Map<string, number>;
declare function O200KBase(bytePairRankDecoder: RawBytePairRanks): EncodingParams;
//#endregion
export { O200KBase, createO200KSpecialTokenMap };
//# sourceMappingURL=o200k_base.d.ts.map