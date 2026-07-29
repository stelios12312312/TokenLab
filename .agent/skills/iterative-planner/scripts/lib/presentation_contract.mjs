// presentation_contract.mjs - E3-5 render and write-authority contracts.

const PRESENTATION_CONTRACT_SCHEMA_VERSION = 1;

const DEFAULT_PRESENTATION_CONTRACTS = Object.freeze({
  dispatch: Object.freeze({
    surface: "dispatch",
    source_schema: "work_order",
    fields: Object.freeze([
      Object.freeze({ name: "id", required: false }),
      Object.freeze({ name: "goal", required: true }),
      Object.freeze({ name: "inputs", required: true }),
      Object.freeze({ name: "constraints", required: true }),
      Object.freeze({ name: "claims_to_produce", required: true }),
      Object.freeze({ name: "proof_obligations", required: true }),
      Object.freeze({ name: "stop_conditions", required: true }),
      Object.freeze({ name: "budget", required: true }),
    ]),
  }),
  step: Object.freeze({
    surface: "step",
    source_schema: "planner_step",
    fields: Object.freeze([
      Object.freeze({ name: "step", required: true }),
      Object.freeze({ name: "files", required: true }),
      Object.freeze({ name: "commit", required: true }),
      Object.freeze({ name: "surprises", required: true }),
      Object.freeze({ name: "next", required: true }),
    ]),
  }),
  receipt: Object.freeze({
    surface: "receipt",
    source_schema: "claims_evidence_receipt",
    fields: Object.freeze([
      Object.freeze({ name: "receipt_type", required: true }),
      Object.freeze({ name: "claims", required: true }),
      Object.freeze({ name: "cost_ledger", required: true }),
      Object.freeze({ name: "invalid_claim_count", required: true }),
    ]),
  }),
});

const DEFAULT_WRITE_AUTHORITY_MATRIX = Object.freeze([
  Object.freeze({
    artifact: "state.json",
    state: "EXECUTE",
    owner: "orchestrator",
    artifact_class: "orchestrator_state",
    writers: Object.freeze([
      Object.freeze({ actor: "orchestrator", paths: Object.freeze(["state"]), sequence: 1 }),
    ]),
  }),
  Object.freeze({
    artifact: "plan.md",
    state: "PLAN",
    owner: "orchestrator",
    artifact_class: "plan_artifact",
    writers: Object.freeze([
      Object.freeze({ actor: "orchestrator", paths: Object.freeze(["problem", "steps", "verification"]), sequence: 1 }),
    ]),
  }),
  Object.freeze({
    artifact: "verification.md",
    state: "VALIDATE",
    owner: "orchestrator",
    artifact_class: "evidence_artifact",
    writers: Object.freeze([
      Object.freeze({ actor: "orchestrator", paths: Object.freeze(["criteria", "proof"]), sequence: 1 }),
    ]),
  }),
]);

function isPlainObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function addIssue(issues, code, path, message) {
  issues.push({ code, path, message });
}

function issueResult(errors, warnings = []) {
  return {
    ok: errors.length === 0,
    status: errors.length === 0 ? "PASS" : "FAIL",
    errors,
    warnings,
  };
}

function cloneContract(contract) {
  if (!isPlainObject(contract)) return contract;
  return {
    ...contract,
    fields: Array.isArray(contract.fields) ? contract.fields.map((field) => ({ ...field })) : [],
  };
}

function normalizeField(field) {
  const source = isPlainObject(field) ? field : { name: field };
  const name = String(source.name || "").trim();
  return {
    name,
    label: isNonEmptyString(source.label) ? source.label.trim() : name,
    source_path: isNonEmptyString(source.source_path) ? source.source_path.trim() : name,
    required: source.required !== false,
  };
}

function normalizeContract(contract, surface = null) {
  const base = cloneContract(contract || DEFAULT_PRESENTATION_CONTRACTS[surface]);
  if (!isPlainObject(base)) return null;
  return {
    surface: isNonEmptyString(base.surface) ? base.surface.trim() : surface,
    source_schema: isNonEmptyString(base.source_schema) ? base.source_schema.trim() : null,
    fields: (Array.isArray(base.fields) ? base.fields : []).map(normalizeField),
  };
}

function canonicalJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (isPlainObject(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function renderValue(value) {
  if (value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || value === null) return String(value);
  return canonicalJson(value);
}

function getValueAtPath(payload, path) {
  if (!isPlainObject(payload) && !Array.isArray(payload)) return undefined;
  const parts = String(path || "").split(".").filter(Boolean);
  let current = payload;
  for (const part of parts) {
    if (current === null || current === undefined) return undefined;
    current = current[part];
  }
  return current;
}

function validatePresentationContract(contract, options = {}) {
  const errors = [];
  const normalized = normalizeContract(contract, options.surface);

  if (!normalized) {
    addIssue(errors, "render_contract_not_object", "contract", "presentation contract must be an object");
    return issueResult(errors);
  }

  if (!isNonEmptyString(normalized.surface)) {
    addIssue(errors, "render_contract_surface_missing", "surface", "presentation contract requires a surface");
  }
  if (!Array.isArray(normalized.fields) || normalized.fields.length === 0) {
    addIssue(errors, "render_contract_fields_empty", "fields", "presentation contract requires at least one field");
  }

  const seen = new Set();
  normalized.fields.forEach((field, index) => {
    const path = `fields[${index}]`;
    if (!isNonEmptyString(field.name)) {
      addIssue(errors, "render_contract_field_name_missing", `${path}.name`, "render field requires a name");
      return;
    }
    if (seen.has(field.name)) {
      addIssue(errors, "duplicate_render_field", `${path}.name`, `Duplicate render field '${field.name}'`);
    }
    seen.add(field.name);
    if (!isNonEmptyString(field.source_path)) {
      addIssue(errors, "render_contract_field_path_missing", `${path}.source_path`, "render field requires a source path");
    }
  });

  const defaultContract = DEFAULT_PRESENTATION_CONTRACTS[normalized.surface];
  if (defaultContract) {
    for (const requiredField of defaultContract.fields.filter((field) => field.required !== false)) {
      if (!seen.has(requiredField.name)) {
        addIssue(
          errors,
          "render_contract_missing_required_field",
          "fields",
          `${normalized.surface} presentation contract must include required field '${requiredField.name}'`,
        );
      }
    }
  }

  return {
    ...issueResult(errors),
    contract: normalized,
  };
}

function resolvePresentationContract(surface, contracts = DEFAULT_PRESENTATION_CONTRACTS) {
  const contract = contracts?.[surface];
  const result = validatePresentationContract(contract, { surface });
  if (!result.ok) {
    const detail = result.errors.map((issue) => `${issue.path}: ${issue.message}`).join("; ");
    throw new Error(`Invalid presentation contract for '${surface}': ${detail}`);
  }
  return result.contract;
}

function renderPresentationBlock(surface, payload, options = {}) {
  const contract = resolvePresentationContract(surface, options.contracts || DEFAULT_PRESENTATION_CONTRACTS);
  const fields = contract.fields.map((field) => {
    const sourceValue = getValueAtPath(payload, field.source_path);
    return {
      name: field.name,
      label: field.label,
      source_path: field.source_path,
      rendered_value: renderValue(sourceValue),
    };
  });
  const lines = [
    `[${surface}]`,
    ...fields.map((field) => `${field.name}: ${field.rendered_value}`),
  ];

  return {
    schema_version: PRESENTATION_CONTRACT_SCHEMA_VERSION,
    surface,
    source_schema: contract.source_schema,
    fields,
    text: lines.join("\n"),
  };
}

function assertVerbatimRender(surface, payload, block, options = {}) {
  const errors = [];
  const warnings = [];
  const contract = resolvePresentationContract(surface, options.contracts || DEFAULT_PRESENTATION_CONTRACTS);

  if (!isPlainObject(block)) {
    addIssue(errors, "render_block_not_object", "block", "rendered block must be an object");
    return issueResult(errors, warnings);
  }
  if (block.surface !== surface) {
    addIssue(errors, "render_surface_mismatch", "surface", `Expected surface '${surface}'`);
  }
  if (!Array.isArray(block.fields)) {
    addIssue(errors, "render_fields_missing", "fields", "rendered block must include fields");
    return issueResult(errors, warnings);
  }
  if (block.fields.length !== contract.fields.length) {
    addIssue(errors, "render_field_count_mismatch", "fields", `Expected ${contract.fields.length} rendered fields`);
  }

  contract.fields.forEach((field, index) => {
    const rendered = block.fields[index];
    const path = `fields[${index}]`;
    if (!isPlainObject(rendered)) {
      addIssue(errors, "render_field_missing", path, `Missing rendered field '${field.name}'`);
      return;
    }
    if (rendered.name !== field.name) {
      addIssue(errors, "render_field_order_mismatch", `${path}.name`, `Expected field '${field.name}' at index ${index}`);
      return;
    }
    const expected = renderValue(getValueAtPath(payload, field.source_path));
    if (rendered.rendered_value !== expected) {
      addIssue(
        errors,
        "render_value_mismatch",
        `${path}.rendered_value`,
        `Rendered value for '${field.name}' does not match source value`,
      );
    }
  });

  return issueResult(errors, warnings);
}

function normalizeWriters(row) {
  if (Array.isArray(row?.writers) && row.writers.length > 0) return row.writers;
  if (isNonEmptyString(row?.owner)) return [{ actor: row.owner, paths: ["*"], sequence: 1 }];
  return [];
}

function isSubAgentActor(actor) {
  return /(^|[_-])(sub|verification|rubric|reviewer|worker)[_-]?agent($|[_-])/.test(String(actor || "")) ||
    /^sub[_-]?agent$/.test(String(actor || ""));
}

function isOrchestratorState(row) {
  return row.artifact_class === "orchestrator_state" ||
    ["state.json", "work_order.json"].includes(row.artifact);
}

function pathsOverlap(left, right) {
  if (left === "*" || right === "*") return true;
  return left === right || left.startsWith(`${right}.`) || right.startsWith(`${left}.`);
}

function validateWriteAuthorityMatrix(matrixInput) {
  const errors = [];
  const warnings = [];
  const rows = Array.isArray(matrixInput)
    ? matrixInput
    : (Array.isArray(matrixInput?.write_authority_matrix) ? matrixInput.write_authority_matrix : null);

  if (!rows) {
    addIssue(errors, "authority_matrix_not_array", "write_authority_matrix", "write authority matrix must be an array");
    return issueResult(errors, warnings);
  }

  const entryKeys = new Set();
  rows.forEach((row, rowIndex) => {
    const rowPath = `write_authority_matrix[${rowIndex}]`;
    if (!isPlainObject(row)) {
      addIssue(errors, "authority_row_not_object", rowPath, "authority row must be an object");
      return;
    }

    for (const field of ["artifact", "state", "owner"]) {
      if (!isNonEmptyString(row[field])) {
        addIssue(errors, `authority_${field}_missing`, `${rowPath}.${field}`, `${field} must be a non-empty string`);
      }
    }

    const entryKey = `${row.artifact || ""}::${row.state || ""}`;
    if (entryKeys.has(entryKey)) {
      addIssue(errors, "duplicate_authority_entry", rowPath, `Duplicate authority row for ${entryKey}`);
    }
    entryKeys.add(entryKey);

    const writers = normalizeWriters(row);
    if (writers.length === 0) {
      addIssue(errors, "authority_writers_empty", `${rowPath}.writers`, "authority row must include at least one writer");
      return;
    }

    const writerActors = new Set();
    const writerPaths = [];
    writers.forEach((writer, writerIndex) => {
      const writerPath = `${rowPath}.writers[${writerIndex}]`;
      if (!isPlainObject(writer)) {
        addIssue(errors, "authority_writer_not_object", writerPath, "writer must be an object");
        return;
      }
      if (!isNonEmptyString(writer.actor)) {
        addIssue(errors, "authority_writer_actor_missing", `${writerPath}.actor`, "writer actor must be non-empty");
        return;
      }
      if (writerActors.has(writer.actor)) {
        addIssue(errors, "duplicate_writer_actor", `${writerPath}.actor`, `Duplicate writer actor '${writer.actor}'`);
      }
      writerActors.add(writer.actor);

      if (isOrchestratorState(row) && writer.actor !== "orchestrator" && isSubAgentActor(writer.actor)) {
        addIssue(
          errors,
          "subagent_orchestrator_state_write",
          `${writerPath}.actor`,
          "sub-agents may not write orchestrator-owned state artifacts",
        );
      }

      const paths = Array.isArray(writer.paths) && writer.paths.length > 0 ? writer.paths : [];
      if (writers.length > 1 && (!Number.isInteger(writer.sequence) || writer.sequence < 1)) {
        addIssue(errors, "unsequenced_multi_writer", `${writerPath}.sequence`, "multi-writer rows require positive integer sequence");
      }
      if (writers.length > 1 && paths.length === 0) {
        addIssue(errors, "multi_writer_paths_missing", `${writerPath}.paths`, "multi-writer rows require disjoint paths");
      }
      paths.forEach((pathValue, pathIndex) => {
        if (!isNonEmptyString(pathValue)) {
          addIssue(errors, "writer_path_invalid", `${writerPath}.paths[${pathIndex}]`, "writer paths must be non-empty strings");
        } else {
          writerPaths.push({ writerIndex, path: pathValue });
        }
      });
    });

    if (!writerActors.has(row.owner)) {
      addIssue(errors, "owner_not_writer", `${rowPath}.owner`, `Owner '${row.owner}' must be one of the declared writers`);
    }

    if (writers.length > 1) {
      for (let left = 0; left < writerPaths.length; left += 1) {
        for (let right = left + 1; right < writerPaths.length; right += 1) {
          if (writerPaths[left].writerIndex !== writerPaths[right].writerIndex && pathsOverlap(writerPaths[left].path, writerPaths[right].path)) {
            addIssue(
              errors,
              "overlapping_writer_path",
              `${rowPath}.writers`,
              `Writer paths '${writerPaths[left].path}' and '${writerPaths[right].path}' overlap`,
            );
          }
        }
      }
    }
  });

  return issueResult(errors, warnings);
}

export {
  DEFAULT_PRESENTATION_CONTRACTS,
  DEFAULT_WRITE_AUTHORITY_MATRIX,
  PRESENTATION_CONTRACT_SCHEMA_VERSION,
  assertVerbatimRender,
  renderPresentationBlock,
  renderValue,
  validatePresentationContract,
  validateWriteAuthorityMatrix,
};
