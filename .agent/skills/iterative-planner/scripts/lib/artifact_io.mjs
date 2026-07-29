import { existsSync, readFileSync, statSync } from "fs";

export const MAX_ARTIFACT_BYTES = 1_048_576;

export function readArtifact(filePath) {
  try {
    if (!existsSync(filePath)) {
      return { ok: true, exists: false, content: "", error: null };
    }
    const st = statSync(filePath);
    if (st.size > MAX_ARTIFACT_BYTES) {
      return { ok: false, exists: true, content: "", error: "file_too_large" };
    }
    return { ok: true, exists: true, content: readFileSync(filePath, "utf8"), error: null };
  } catch (err) {
    return { ok: false, exists: true, content: "", error: err?.code || "read_error" };
  }
}
