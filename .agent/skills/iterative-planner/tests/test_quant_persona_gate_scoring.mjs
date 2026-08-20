import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { detectQuantPersonaScope } from "../scripts/lib/quant_persona_gate.mjs";

const __filename = fileURLToPath(import.meta.url);
const testDir = dirname(__filename);

function runTests() {
  const genuinePath = join(testDir, "fixtures", "persona_quant_genuine.json");
  const fpPath = join(testDir, "fixtures", "persona_quant_false_positive.json");

  const genuineInput = JSON.parse(readFileSync(genuinePath, "utf-8"));
  const fpInput = JSON.parse(readFileSync(fpPath, "utf-8"));

  const genuineResult = detectQuantPersonaScope(genuineInput);
  if (!genuineResult.required) {
    console.error("FAIL: genuine quant intake should be required");
    console.error(genuineResult);
    process.exit(1);
  }

  const fpResult = detectQuantPersonaScope(fpInput);
  if (fpResult.required) {
    console.error("FAIL: false positive quant intake should not be required");
    console.error(fpResult);
    process.exit(1);
  }
  
  if (fpResult.reason !== "conflicting_signals_advisory") {
    console.error("FAIL: false positive should have advisory reason");
    console.error(fpResult);
    process.exit(1);
  }

  console.log("PASS: test_quant_persona_gate_scoring.mjs");
}

runTests();
