// script_entrypoint.mjs — Direct-invocation detection for ESM scripts.
//
// Compares realpaths of process.argv[1] and the caller's import.meta.url so
// macOS /var/folders vs /private/var/folders symlinks don't falsely skip the
// main() branch. Extracted from repeated direct-invocation checks where the
// same realpath idiom was duplicated and the symlink-correctness fix had to be
// discovered twice.

import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function isDirectInvocation(importMetaUrl) {
  if (!process.argv[1] || !importMetaUrl) return false;
  const __filename = fileURLToPath(importMetaUrl);
  try {
    return realpathSync(process.argv[1]) === realpathSync(__filename);
  } catch {
    return resolve(process.argv[1]) === __filename;
  }
}
