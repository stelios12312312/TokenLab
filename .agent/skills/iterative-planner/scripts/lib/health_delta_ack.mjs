import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { extractMarkdownSection } from "./plan_utils.mjs";

function firstField(section, labelPattern) {
  const match = section.match(new RegExp(`^\\s*[-*]?\\s*${labelPattern}\\s*:\\s*(.+)$`, "im"));
  return match ? match[1].trim() : "";
}

function allFields(section, labelPattern) {
  const values = [];
  const re = new RegExp(`^\\s*[-*]?\\s*${labelPattern}\\s*:\\s*(.+)$`, "gim");
  let match;
  while ((match = re.exec(section))) {
    values.push(match[1].trim());
  }
  return values;
}

function invalid(reason, extra = {}) {
  return {
    acknowledged: false,
    reason,
    ...extra,
  };
}

export function parseHealthDeltaAcknowledgement(markdownContent, opts = {}) {
  const newFails = Number.isFinite(Number(opts.newFails)) ? Number(opts.newFails) : 0;
  const section = extractMarkdownSection(markdownContent || "", "Health Delta Acknowledgement");
  if (!section.trim()) return invalid("missing_section");

  const status = firstField(section, "Status");
  const reason = firstField(section, "Reason");
  const expectedRaw = firstField(section, "Expected\\s+new\\s+failures?");
  const expectedNewFailures = Number(expectedRaw);
  const artifacts = allFields(section, "(?:Canonical\\s+artifact|Artifact|Evidence)");
  const artifactText = artifacts.join("\n");
  const canonicalText = `${reason}\n${artifactText}`;

  if (!/\b(?:acknowledged|accepted|intentional|expected|approved)\b/i.test(status)) {
    return invalid("status_not_acknowledged", { status });
  }
  if (!Number.isInteger(expectedNewFailures) || expectedNewFailures < 0) {
    return invalid("missing_expected_new_failures", { status, expectedRaw });
  }
  if (expectedNewFailures < newFails) {
    return invalid("expected_new_failures_too_low", { status, expectedNewFailures, newFails });
  }
  if (!reason.trim()) {
    return invalid("missing_reason", { status, expectedNewFailures });
  }
  if (!artifacts.length) {
    return invalid("missing_canonical_artifact", { status, expectedNewFailures, acknowledgementReason: reason });
  }
  if (!/(?:story[_ -]?registry|project[_ -]?health|planner[_ -]?truth|canonical)/i.test(canonicalText)) {
    return invalid("missing_canonical_signal", { status, expectedNewFailures, acknowledgementReason: reason, artifacts });
  }

  return {
    acknowledged: true,
    status,
    reason,
    expectedNewFailures,
    artifacts,
  };
}

export function readHealthDeltaAcknowledgement(planDir, opts = {}) {
  for (const fileName of ["verification.md", "reflection.md", "plan.md"]) {
    const filePath = join(planDir, fileName);
    if (!existsSync(filePath)) continue;
    const parsed = parseHealthDeltaAcknowledgement(readFileSync(filePath, "utf-8"), opts);
    if (parsed.acknowledged) {
      return {
        ...parsed,
        sourceFile: fileName,
      };
    }
    if (parsed.reason !== "missing_section") {
      return {
        ...parsed,
        sourceFile: fileName,
      };
    }
  }
  return invalid("missing_section");
}
