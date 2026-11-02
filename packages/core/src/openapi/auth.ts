/**
 * `./openapi/auth`: HTTP Basic in front of a served document. `basic({ realm, verify })` is the guard
 * `serveOpenApi` and `serveStaticOpenApi` take as `auth`, checked on every route the call mounts, so a
 * browser opens an internal document and its docs pages with one prompt. `credentialsMatch` compares a
 * pair in constant time.
 */
export { type BasicAuthOptions, basic, type Credentials, credentialsMatch, type ServedAuth } from "./basic-auth.ts"
