import { readFileSync } from "fs";
import tokenomicsPack from "../.agent/skills/iterative-planner/packs/tokenomics/index.mjs";

const findings = readFileSync("plans/plan_2026-06-09_e5b724d4c8543cf9/findings.md", "utf8");
const parsed = tokenomicsPack.extractTokenomicsInput(findings);
console.log(JSON.stringify(parsed, null, 2));
