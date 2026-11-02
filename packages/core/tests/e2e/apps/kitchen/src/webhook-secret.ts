/* a fixed test key, so the e2e receiver can verify what the route signs; never a real secret. Its own module, free of
   core, since the Playwright runner imports it outside the honey-source condition */
export const WEBHOOK_SECRET = `whsec_${btoa("kitchen-e2e-webhook-test-key-32b")}`
