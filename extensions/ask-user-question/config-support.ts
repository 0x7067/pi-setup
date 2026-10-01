/**
 * Local replacement for the parts of `@juicesharp/rpiv-config` this extension
 * uses: JSON config loading with the legacy ~/.config fallback, and the
 * guidance-field validator. Vendored so the extension carries no rpiv-* package
 * dependency. Derived from rpiv-config 2.9.0 (MIT, juicesharp) — see LICENSE.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { logDiagnostic } from "../shared/console-guard.ts";

export interface GuidanceFields {
	promptSnippet?: string;
	promptGuidelines?: string[];
	description?: string;
}

function readEnvVar(key: string): string | undefined {
	return process.env[key]?.trim() || undefined;
}

function expandTilde(p: string): string {
	if (p === "~") return homedir();
	if (p.startsWith("~/")) return join(homedir(), p.slice(2));
	return p;
}

function defaultConfigDir(): string {
	return join(homedir(), ".config");
}

function resolveConfigDir(): string {
	const xdg = readEnvVar("XDG_CONFIG_HOME");
	if (!xdg) return defaultConfigDir();
	const expanded = expandTilde(xdg);
	return isAbsolute(expanded) ? expanded : defaultConfigDir();
}

function legacyConfigPath(name: string, file: string): string {
	return join(defaultConfigDir(), name, file);
}

function configPath(name: string, file: string): string {
	return join(resolveConfigDir(), name, file);
}

function loadJsonConfig<T>(path: string): T {
	if (!existsSync(path)) return {} as T;
	try {
		const parsed = JSON.parse(readFileSync(path, "utf-8")) as unknown;
		if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {} as T;
		return parsed as T;
	} catch (err) {
		logDiagnostic(`ask-user-question: invalid JSON at ${path}, using defaults — ${(err as Error).message}`);
		return {} as T;
	}
}

/**
 * Load JSON config, preferring the XDG-resolved path and falling back to the
 * legacy `~/.config/<name>/<file>` location only when the XDG path is missing.
 */
export function loadJsonConfigWithLegacyFallback<T>(name: string, file = "config.json"): T {
	const xdgPath = configPath(name, file);
	if (existsSync(xdgPath)) return loadJsonConfig<T>(xdgPath);
	return loadJsonConfig<T>(legacyConfigPath(name, file));
}

/**
 * Validate and extract guidance fields from an unknown value, keeping only
 * non-empty entries. Byte-identical logic to rpiv-config's exported validator.
 */
export function validateGuidanceFields(fields: unknown): GuidanceFields {
	if (!fields || typeof fields !== "object") return {};
	const g = fields as Record<string, unknown>;
	const result: GuidanceFields = {};
	if (typeof g.promptSnippet === "string" && g.promptSnippet.length > 0) {
		result.promptSnippet = g.promptSnippet;
	}
	if (
		Array.isArray(g.promptGuidelines) &&
		g.promptGuidelines.length > 0 &&
		g.promptGuidelines.every((s) => typeof s === "string" && s.length > 0)
	) {
		result.promptGuidelines = g.promptGuidelines;
	}
	if (typeof g.description === "string" && g.description.length > 0) {
		result.description = g.description;
	}
	return result;
}
