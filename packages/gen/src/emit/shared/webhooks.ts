/**
 * The webhook verify helper every SDK ships: one function per language that checks an
 * HMAC-SHA256 signature over the raw payload. It strips the signature's prefix, decodes it as hex
 * or base64, and compares the digests with the language's constant-time primitive, never `==`
 * (H18.9: a timing oracle cannot be fuzzed, so the comparison is asserted structurally). An
 * undecodable, short or oddly encoded signature is false. The helper is the same for every
 * webhook; a webhook's own header name and prefix reach an SDK as literals through F2. The typed
 * payload parser is each SDK's own (bits 11–16).
 */
import type { IRSignature } from "../../ir/model.ts"
import { stringLiteral, type Target } from "./escape.ts"

export const WEBHOOK_LANGUAGES = ["csharp", "go", "java", "python", "rust", "ts"] as const

export type WebhookLanguage = (typeof WEBHOOK_LANGUAGES)[number]

const HELPERS: Readonly<Record<WebhookLanguage, string>> = {
	csharp: `using System;
using System.Security.Cryptography;
using System.Text;

public static class WebhookSignature
{
    /// <summary>Whether <paramref name="received"/> is the HMAC-SHA256 of <paramref name="payload"/> under <paramref name="secret"/>.</summary>
    public static bool VerifyWebhookSignature(byte[] secret, byte[] payload, string received, string encoding, string prefix)
    {
        if (!received.StartsWith(prefix, StringComparison.Ordinal)) return false;
        var text = received.Substring(prefix.Length);
        byte[] given;
        try
        {
            if (encoding == "hex") given = Convert.FromHexString(text);
            else if (encoding == "base64") given = Convert.FromBase64String(text);
            else return false;
        }
        catch (FormatException)
        {
            return false;
        }
        using var hmac = new HMACSHA256(secret);
        var expected = hmac.ComputeHash(payload);
        return CryptographicOperations.FixedTimeEquals(expected, given);
    }
}
`,
	go: `package webhooks

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"strings"
)

// VerifyWebhookSignature reports whether received is the HMAC-SHA256 of payload under secret.
func VerifyWebhookSignature(secret []byte, payload []byte, received string, encoding string, prefix string) bool {
	if !strings.HasPrefix(received, prefix) {
		return false
	}
	text := strings.TrimPrefix(received, prefix)
	var given []byte
	var err error
	switch encoding {
	case "hex":
		given, err = hex.DecodeString(text)
	case "base64":
		given, err = base64.StdEncoding.DecodeString(text)
	default:
		return false
	}
	if err != nil {
		return false
	}
	mac := hmac.New(sha256.New, secret)
	mac.Write(payload)
	expected := mac.Sum(nil)
	return hmac.Equal(expected, given)
}
`,
	java: `import java.security.MessageDigest;
import java.util.Base64;
import java.util.HexFormat;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;

public final class WebhookSignature {
    private WebhookSignature() {}

    /** Whether {@code received} is the HMAC-SHA256 of {@code payload} under {@code secret}. */
    public static boolean verifyWebhookSignature(byte[] secret, byte[] payload, String received, String encoding, String prefix) {
        if (!received.startsWith(prefix)) return false;
        String text = received.substring(prefix.length());
        byte[] given;
        try {
            if ("hex".equals(encoding)) given = HexFormat.of().parseHex(text);
            else if ("base64".equals(encoding)) given = Base64.getDecoder().decode(text);
            else return false;
        } catch (IllegalArgumentException invalid) {
            return false;
        }
        try {
            Mac mac = Mac.getInstance("HmacSHA256");
            mac.init(new SecretKeySpec(secret, "HmacSHA256"));
            byte[] expected = mac.doFinal(payload);
            return MessageDigest.isEqual(expected, given);
        } catch (java.security.GeneralSecurityException unavailable) {
            throw new IllegalStateException("HmacSHA256 is unavailable", unavailable);
        }
    }
}
`,
	python: `import base64
import binascii
import hashlib
import hmac


def verify_webhook_signature(secret: bytes, payload: bytes, received: str, encoding: str, prefix: str) -> bool:
    """Whether \`received\` is the HMAC-SHA256 of \`payload\` under \`secret\`."""
    if not received.startswith(prefix):
        return False
    text = received[len(prefix):]
    try:
        if encoding == "hex":
            given = bytes.fromhex(text)
        elif encoding == "base64":
            given = base64.b64decode(text, validate=True)
        else:
            return False
    except (ValueError, binascii.Error):
        return False
    expected = hmac.new(secret, payload, hashlib.sha256).digest()
    return hmac.compare_digest(expected, given)
`,
	rust: `use base64::Engine as _;
use hmac::{Hmac, Mac};
use sha2::Sha256;
use subtle::ConstantTimeEq;

/// Whether \`received\` is the HMAC-SHA256 of \`payload\` under \`secret\`.
pub fn verify_webhook_signature(secret: &[u8], payload: &[u8], received: &str, encoding: &str, prefix: &str) -> bool {
    let Some(text) = received.strip_prefix(prefix) else { return false };
    let decoded = match encoding {
        "hex" => hex::decode(text).ok(),
        "base64" => base64::engine::general_purpose::STANDARD.decode(text).ok(),
        _ => None,
    };
    let Some(given) = decoded else { return false };
    let Ok(mut mac) = Hmac::<Sha256>::new_from_slice(secret) else { return false };
    mac.update(payload);
    let expected = mac.finalize().into_bytes().to_vec();
    expected.ct_eq(&given).into()
}
`,
	ts: `import { createHmac, timingSafeEqual } from "node:crypto"

/** Whether \`received\` is the HMAC-SHA256 of \`payload\` under \`secret\`. */
export function verifyWebhookSignature(
	secret: string | Uint8Array,
	payload: string | Uint8Array,
	received: string,
	encoding: string,
	prefix: string,
): boolean {
	if (!received.startsWith(prefix)) return false
	const text = received.slice(prefix.length)
	const pattern = encoding === "hex" ? /^(?:[0-9a-fA-F]{2})*$/ : encoding === "base64" ? /^[A-Za-z0-9+/]*={0,2}$/ : null
	if (pattern === null || !pattern.test(text)) return false
	const given = Buffer.from(text, encoding === "hex" ? "hex" : "base64")
	const expected = createHmac("sha256", secret).update(payload).digest()
	/* a SHA-256 digest is 32 bytes; timingSafeEqual takes equal lengths only */
	if (given.length !== 32) return false
	return timingSafeEqual(expected, given)
}
`,
}

/** The verify helper in `language`, a whole source file of its own. */
export function verifyHelper(language: WebhookLanguage): string {
	return HELPERS[language]
}

/** A webhook's signature header name and prefix as `target`'s string literals. */
export function signatureLiterals(target: Target, signature: IRSignature): { header: string; prefix: string } {
	return { header: stringLiteral(signature.header, target), prefix: stringLiteral(signature.prefix, target) }
}
