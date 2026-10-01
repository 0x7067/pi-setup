/**
 * Ambient declarations for the optional `@juicesharp/rpiv-i18n` peer. The
 * package is a soft dependency — it is dynamically imported and the extension
 * stays online (English fallback) when it is absent — so it is intentionally
 * NOT in package.json. These module declarations let `tsc` type-check the two
 * dynamic-import sites; the runtime import still resolves (or rejects) against
 * whatever is actually installed.
 */

declare module "@juicesharp/rpiv-i18n" {
	export function scope(namespace: string): (key: string, fallback: string) => string;
}

declare module "@juicesharp/rpiv-i18n/loader" {
	export function registerLocalesFromDir(
		namespace: string,
		packageUrl: string,
		options?: { label?: string },
	): void;
}
