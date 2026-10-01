import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const hookKey = Symbol.for("pi.shared-imports.hook");

if (!Reflect.get(globalThis, hookKey)) {
  const installRoot = process.env.PI_MANAGED_INSTALL_ROOT;
  const version = installRoot
    ? readFileSync(join(installRoot, "current-version"), "utf8").trim()
    : "";
  const releaseParent = installRoot && version
    ? pathToFileURL(
        join(
          installRoot,
          "releases",
          version,
          "node_modules",
          "@earendil-works",
          "pi-coding-agent",
          "dist",
          "bundle",
          "cli.js",
        ),
      ).href
    : "";
  const sharedPackage =
    /^(?:@earendil-works\/(?:pi-ai|pi-agent-core|pi-coding-agent|pi-tui)(?:\/.*)?|typebox(?:\/.*)?)$/;

  if (releaseParent) {
    registerHooks({
      resolve(specifier, context, nextResolve) {
        if (sharedPackage.test(specifier)) {
          return nextResolve(specifier, { ...context, parentURL: releaseParent });
        }
        return nextResolve(specifier, context);
      },
    });
    Reflect.set(globalThis, hookKey, true);
  }
}

export default function sharedPiImports() {}
