/** The one API key the e2e app's guard takes (no import, so a Playwright test reads it from any host). */
export const KEY = "ak_e2e_0123456789abcdef"

/** The upload tokens' HMAC key: a test's fixed value, where an app reads its own from an env binding. */
export const UPLOAD_SECRET = "e2e-upload-secret-0123456789abcdef"
