import { readFileSync } from "fs";
import tokenomicsPack from "../.agent/skills/iterative-planner/packs/tokenomics/index.mjs";

const planDir = "plans/plan_2026-06-09_55f19326ff45bbe3";
const planFiles = {
  "plan.md": readFileSync(`${planDir}/plan.md`, "utf8"),
  "findings.md": readFileSync(`${planDir}/findings.md`, "utf8"),
  "state.md": readFileSync(`${planDir}/state.md`, "utf8"),
};

const context = {
  cwd: process.cwd(),
  planFiles,
  currentState: "explore",
  storyRegistry: JSON.parse(readFileSync("reports/user_story_audit/story_registry.json", "utf8")),
};

console.log("Applies?", tokenomicsPack.applies(context));
const findingsText = readFileSync(`${planDir}/findings.md`, "utf8");
const planText = readFileSync(`${planDir}/plan.md`, "utf8");

function scan(text, name) {
  const lines = text.split(/\n/);
  for (const line of lines) {
    const lower = line.toLowerCase();
    if (/(allocation|distribution|bucket)/.test(lower)) {
      console.log(`[${name}] MATCHING LINE:`, line.trim());
      for (const match of String(line).matchAll(/([0-9][0-9,]*(?:\.[0-9]+)?)\s*%/g)) {
        console.log(`  [${name}] MATCHED PERCENT:`, match[1]);
      }
    }
  }
}

scan(findingsText, "findings.md");
scan(planText, "plan.md");

const input = tokenomicsPack.extractTokenomicsInput(context);
console.log("Parsed Input:", JSON.stringify(input, null, 2));




const findings = await tokenomicsPack.audit(context);
console.log("Findings:", JSON.stringify(findings, null, 2));
