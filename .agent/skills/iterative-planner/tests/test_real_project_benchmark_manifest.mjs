#!/usr/bin/env node
// test_real_project_benchmark_manifest.mjs — contract coverage for registry-backed real-project benchmark cohorts.

import { dirname, resolve } from "path";
import { fileURLToPath } from "url";

import {
  loadRealProjectCohorts,
  matchRegisteredProject,
} from "../scripts/knowledge_benchmark.mjs";

const __filename = fileURLToPath(import.meta.url);
const testDir = dirname(__filename);
const plannerRoot = resolve(testDir, "..", "..", "..", "..");

let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) {
    passed++;
    console.log(`  PASS: ${label}`);
  } else {
    failed++;
    console.log(`  FAIL: ${label}`);
  }
}

const cohorts = loadRealProjectCohorts();
assert(Array.isArray(cohorts) && cohorts.length >= 5, "real-project benchmark manifest loads at least five cohort definitions");
assert(cohorts.every((entry) => typeof entry.id === "string" && entry.id.trim()), "real-project benchmark manifest requires stable cohort ids");
assert(cohorts.every((entry) => Array.isArray(entry.path_fragments) && entry.path_fragments.length > 0), "real-project benchmark manifest requires path fragment matchers");
assert(cohorts.every((entry) => typeof entry.goal === "string" && entry.goal.trim()), "real-project benchmark manifest requires benchmark goals");
assert(cohorts.every((entry) => typeof entry.expected?.entrypoint === "string" && entry.expected.entrypoint.startsWith("/")), "real-project benchmark manifest requires workflow entrypoint expectations");
assert(cohorts.every((entry) => entry.recommended_policy && typeof entry.recommended_policy === "object" && !Array.isArray(entry.recommended_policy)), "real-project benchmark manifest requires a recommended discovery policy scaffold");
assert(cohorts.some((entry) => entry.archetype === "quant" && entry.expected.entrypoint === "/sme-improvement"), "real-project benchmark manifest includes a quant SME cohort");
assert(cohorts.some((entry) => entry.archetype === "workflow_automation" && entry.expected.entrypoint === "/recipe-discovery"), "real-project benchmark manifest includes a workflow automation recipe-discovery cohort");
assert(cohorts.some((entry) => entry.archetype === "cms_plugin" && entry.expected.entrypoint === "/safe-change-power"), "real-project benchmark manifest includes a CMS/plugin guardrail cohort");

const mockRegistry = {
  projects: [
    { path: "/tmp/Courses/learndash-auto-course-tesseract", type: "standard" },
    { path: "/tmp/Investment/ValueInvestingAI", type: "standard" },
    { path: "/tmp/Courses/wp-membership-plugin/wp-membership-plugin-tesseract", type: "standard" },
    { path: "/tmp/Courses/crawler-extractor-agent", type: "standard" },
    { path: "/tmp/Courses/Executives course/tesseract-automation-engine", type: "standard" },
  ],
};

const quantCohort = cohorts.find((entry) => entry.archetype === "quant");
const courseCohort = cohorts.find((entry) => entry.archetype === "ux_ui_course");
const workflowCohort = cohorts.find((entry) => entry.archetype === "workflow_automation");

assert(matchRegisteredProject(mockRegistry.projects, quantCohort?.path_fragments)?.path.includes("ValueInvestingAI"), "matchRegisteredProject resolves the quant cohort from path fragments");
assert(matchRegisteredProject(mockRegistry.projects, courseCohort?.path_fragments)?.path.includes("learndash-auto-course-tesseract"), "matchRegisteredProject resolves the course-generation cohort from path fragments");
assert(matchRegisteredProject(mockRegistry.projects, workflowCohort?.path_fragments)?.path.includes("tesseract-automation-engine"), "matchRegisteredProject resolves the workflow automation cohort from path fragments");
assert(matchRegisteredProject(mockRegistry.projects, ["does-not-exist"]) === null, "matchRegisteredProject returns null when no registered project matches");

console.log(`\nResults: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
