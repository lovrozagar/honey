import { chatEnabledModels } from "./modelsChatEnabled.gen.js";
import { modelsMap_exports } from "./modelsMap.js";
import { ImSep } from "./specialTokens.js";
//#region src/mapping.ts
const cl100k_base = "cl100k_base";
const gpt2 = "gpt2";
const p50k_base = "p50k_base";
const p50k_edit = "p50k_edit";
const r50k_base = "r50k_base";
const o200k_base = "o200k_base";
const o200k_harmony = "o200k_harmony";
const DEFAULT_ENCODING = o200k_base;
const encodingNames = [
	gpt2,
	p50k_base,
	r50k_base,
	p50k_edit,
	cl100k_base,
	o200k_base,
	o200k_harmony
];
/**
* maps model names to encoding names
* if a model is not listed, it uses the default encoding for new models
* which is `o200k_base`
*/
const modelToEncodingMap = Object.fromEntries(Object.entries(modelsMap_exports).flatMap(([encodingName, models]) => models.map((modelName) => [modelName, encodingName])));
const gpt3params = {
	messageSeparator: "\n",
	roleSeparator: "\n"
};
const gpt4params = {
	messageSeparator: "",
	roleSeparator: ImSep
};
const chatModelParams = Object.fromEntries(chatEnabledModels.flatMap((modelName) => modelName.startsWith("gpt-3.5") ? [[modelName, gpt3params]] : [[modelName, gpt4params]]));
//#endregion
export { DEFAULT_ENCODING, chatModelParams, cl100k_base, encodingNames, gpt2, modelToEncodingMap, o200k_base, o200k_harmony, p50k_base, p50k_edit, r50k_base };

//# sourceMappingURL=mapping.js.map