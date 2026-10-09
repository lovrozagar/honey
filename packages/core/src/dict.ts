/**
 * An object for keys that come from request data: search params, form fields, header views,
 * validation field maps. It has no prototype, so a key named `__proto__`, `constructor` or
 * `toString` is plain data — it cannot hit `Object.prototype`, replace the object's prototype,
 * or turn a missing key into a function.
 *
 * Read keys with `key in obj`, `obj[key] !== undefined` or `Object.hasOwn(obj, key)`; the
 * object has no `hasOwnProperty` method of its own.
 */
export function dict<T>(): Record<string, T> {
	return Object.create(null) as Record<string, T>
}
