import { buildEnvelope, getEnvelopePath } from "../.agent/skills/iterative-planner/scripts/lib/plan_contract.mjs";
import { readStateJson, writeStateJson } from "../.agent/skills/iterative-planner/scripts/lib/determinism.mjs";
import { writeFileSync } from "fs";

const planDir = "./plans/plan_2026-06-01_7950ad8b6de277cf";
const approvalNonce = "5bd2c19fc0245e8d";
const approverOrigin = "auto";

console.log("Building envelope...");
const result = buildEnvelope(planDir, { approvalNonce, approverOrigin });
if (!result.envelope) {
  console.error("Failed to build envelope:", result);
  process.exit(1);
}

console.log("Envelope constructed:", result.envelope);
const envelopePath = getEnvelopePath(planDir);
writeFileSync(envelopePath, JSON.stringify(result.envelope, null, 2) + "\n");
console.log("Wrote envelope to:", envelopePath);

const sj = readStateJson(planDir);
if (sj) {
  sj.approval_envelope_path = "approval_envelope.json";
  sj.approval_envelope_schema = result.envelope.schema_version;
  writeStateJson(planDir, sj);
  console.log("Updated state.json with envelope pointer");
} else {
  console.error("Could not read state.json");
}
