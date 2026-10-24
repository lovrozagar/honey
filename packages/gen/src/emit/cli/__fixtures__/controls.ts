/**
 * Whether `text` holds a character a terminal acts on: a C0 control but line feed and tab, DEL, C1, the BOM, or a
 * line or paragraph separator.
 */
export const hasControl = (text: string): boolean =>
	[...text].some((ch) => {
		const cp = ch.codePointAt(0) as number
		return (
			(cp < 0x20 && cp !== 0x0a && cp !== 0x09) ||
			(cp >= 0x7f && cp <= 0x9f) ||
			cp === 0xfeff ||
			cp === 0x2028 ||
			cp === 0x2029
		)
	})
