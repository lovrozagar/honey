/**
 * Whether `text` holds a character a terminal acts on or that reorders what it shows: a C0 control but line feed and
 * tab, DEL, C1, the BOM, a line or paragraph separator, or a bidi control.
 */
export const hasControl = (text: string): boolean =>
	[...text].some((ch) => {
		const cp = ch.codePointAt(0) as number
		return (
			(cp < 0x20 && cp !== 0x0a && cp !== 0x09) ||
			(cp >= 0x7f && cp <= 0x9f) ||
			cp === 0xfeff ||
			cp === 0x2028 ||
			cp === 0x2029 ||
			[0x061c, 0x200e, 0x200f].includes(cp) ||
			(cp >= 0x202a && cp <= 0x202e) ||
			(cp >= 0x2066 && cp <= 0x2069)
		)
	})
