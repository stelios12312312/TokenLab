import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SpreadsheetFile, Workbook } from "@oai/artifact-tool";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputDir = path.join(repoRoot, "outputs", "v4_decision_grade");
const previewDir = path.join(outputDir, "workbook_previews");
const outputPath = path.join(outputDir, "z1_v4_decision_grade_investor_workbook.xlsx");

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    const next = text[i + 1];
    if (ch === '"' && inQuotes && next === '"') {
      cell += '"';
      i += 1;
    } else if (ch === '"') {
      inQuotes = !inQuotes;
    } else if (ch === "," && !inQuotes) {
      row.push(cell);
      cell = "";
    } else if ((ch === "\n" || ch === "\r") && !inQuotes) {
      if (ch === "\r" && next === "\n") i += 1;
      row.push(cell);
      if (row.some((v) => v !== "")) rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += ch;
    }
  }
  if (cell !== "" || row.length) {
    row.push(cell);
    rows.push(row);
  }
  const headers = rows.shift() ?? [];
  return rows.map((values) => Object.fromEntries(headers.map((h, idx) => [h, coerce(values[idx] ?? "")])));
}

function coerce(value) {
  if (value === "True") return true;
  if (value === "False") return false;
  if (value === "") return null;
  const num = Number(value);
  return Number.isFinite(num) && String(value).trim() !== "" ? num : value;
}

async function readCsv(name) {
  return parseCsv(await fs.readFile(path.join(outputDir, name), "utf8"));
}

function matrixFromObjects(rows, headers) {
  return [headers, ...rows.map((row) => headers.map((header) => row[header] ?? null))];
}

function colLetter(idx0) {
  let n = idx0 + 1;
  let s = "";
  while (n > 0) {
    const mod = (n - 1) % 26;
    s = String.fromCharCode(65 + mod) + s;
    n = Math.floor((n - mod) / 26);
  }
  return s;
}

function setTitle(sheet, title, subtitle) {
  sheet.getRange("A1:H1").merge();
  sheet.getRange("A1").values = [[title]];
  sheet.getRange("A1").format = {
    fill: "#17324D",
    font: { bold: true, color: "#FFFFFF", size: 16 },
  };
  sheet.getRange("A2:H2").merge();
  sheet.getRange("A2").values = [[subtitle]];
  sheet.getRange("A2").format = {
    fill: "#EAF0F6",
    font: { color: "#1F2937", size: 10 },
    wrapText: true,
  };
}

function styleTable(sheet, rangeAddress, headerRows = 1) {
  const range = sheet.getRange(rangeAddress);
  range.format.borders = { preset: "outside", style: "thin", color: "#9CA3AF" };
  const headerRange = sheet.getRange(rangeAddress.split(":")[0]).resize(headerRows, range.columnCount);
  headerRange.format = {
    fill: "#244765",
    font: { bold: true, color: "#FFFFFF" },
    wrapText: true,
  };
}

function setWidths(sheet, widths) {
  widths.forEach((width, idx) => {
    sheet.getCell(0, idx).format.columnWidth = width;
  });
}

function addSourceNote(sheet, row, item, source, notes) {
  sheet.getRange(`A${row}:D${row}`).values = [[item, source, new Date(), notes]];
}

const workbook = Workbook.create();
const cover = workbook.worksheets.add("Cover");
const assumptions = workbook.worksheets.add("Assumptions");
const forecast = workbook.worksheets.add("Forecast Model");
const risk = workbook.worksheets.add("Scenario Risk");
const sensitivity = workbook.worksheets.add("Sensitivity");
const checks = workbook.worksheets.add("Checks");
const sources = workbook.worksheets.add("Sources Audit");

for (const sheet of [cover, assumptions, forecast, risk, sensitivity, checks, sources]) {
  sheet.showGridLines = false;
}

const metrics = await readCsv("v4_simulation_metrics.csv");
const scenarios = await readCsv("v4_scenario_definitions.csv");
const riskRows = await readCsv("v4_risk_summary.csv");
const sensDrivers = await readCsv("v4_sensitivity_drivers.csv");
const rankRows = await readCsv("v4_sensitivity_rank_stability.csv");
const validationRows = await readCsv("v4_validation_matrix.csv");
const reconciliation = JSON.parse(await fs.readFile(path.join(outputDir, "v4_reconciliation.json"), "utf8"));

setTitle(cover, "Z1 Simulation V4 Decision-Grade Workbook", "Typed accounting, adoption-coupled economics, stochastic risk, sensitivity, and validation evidence. Investor-reviewable package; not a signed audit or investment opinion.");
setWidths(cover, [24, 18, 16, 16, 3, 18, 18, 18]);
cover.getRange("A4:D4").values = [["Metric", "Value", "Source", "Status"]];
cover.getRange("A5:D12").values = [
  ["Model status", null, "Checks", null],
  ["Base stable probability", null, "Scenario Risk", "Forecast scenario"],
  ["Reverse-stress fragile probability", null, "Scenario Risk", "Diagnostic only"],
  ["Final treasury USD", null, "Forecast Model", "Base run"],
  ["Final audience reserve Z1U", null, "Forecast Model", "Base run"],
  ["Final active users", null, "Forecast Model", "Base run"],
  ["ACR reconciliation", null, "Checks", "Control"],
  ["Z1U reconciliation", null, "Checks", "Control"],
];
const metricHeaders = Object.keys(metrics[0]);
const forecastCols = Object.fromEntries(metricHeaders.map((header, idx) => [header, colLetter(idx)]));
const lastForecastRow = 4 + metrics.length;

cover.getRange("B5:B12").formulas = [
  ["='Checks'!E5"],
  ["='Scenario Risk'!E5"],
  ["='Scenario Risk'!F9"],
  [`=INDEX('Forecast Model'!${forecastCols.treasury_usd}5:${forecastCols.treasury_usd}${lastForecastRow},ROWS('Forecast Model'!${forecastCols.treasury_usd}5:${forecastCols.treasury_usd}${lastForecastRow}))`],
  [`=INDEX('Forecast Model'!${forecastCols.audience_reserve_z1u}5:${forecastCols.audience_reserve_z1u}${lastForecastRow},ROWS('Forecast Model'!${forecastCols.audience_reserve_z1u}5:${forecastCols.audience_reserve_z1u}${lastForecastRow}))`],
  [`=INDEX('Forecast Model'!${forecastCols.active_users}5:${forecastCols.active_users}${lastForecastRow},ROWS('Forecast Model'!${forecastCols.active_users}5:${forecastCols.active_users}${lastForecastRow}))`],
  ["='Checks'!E6"],
  ["='Checks'!E7"],
];
cover.getRange("A14:D19").values = [["Scenario", "Stable", "Fragile", "Collapse"], ...riskRows.map((r) => [r.scenario_id, r.stable_probability, r.fragile_probability, r.collapse_probability])];
styleTable(cover, "A4:D12");
styleTable(cover, "A14:D19");
cover.getRange("B6:B7").format.numberFormat = "0.0%";
cover.getRange("B8:B10").format.numberFormat = "#,##0";
cover.getRange("B15:D19").format.numberFormat = "0.0%";
const riskChart = cover.charts.add("bar", cover.getRange("A14:D19"));
riskChart.title = "Scenario Outcome Probabilities";
riskChart.hasLegend = true;
riskChart.xAxis = { axisType: "textAxis" };
riskChart.yAxis = { numberFormatCode: "0%" };
riskChart.setPosition("F4", "M19");

setTitle(assumptions, "Assumptions", "Scenario definitions and key model inputs. Blue font indicates scenario/input values.");
const scenarioHeaders = Object.keys(scenarios[0]);
assumptions.getRangeByIndexes(3, 0, scenarios.length + 1, scenarioHeaders.length).values = matrixFromObjects(scenarios, scenarioHeaders);
styleTable(assumptions, `A4:${String.fromCharCode(64 + scenarioHeaders.length)}${4 + scenarios.length}`);
assumptions.getRangeByIndexes(4, 6, scenarios.length, scenarioHeaders.length - 6).format.font = { color: "#0000FF" };
assumptions.getRangeByIndexes(4, 6, scenarios.length, scenarioHeaders.length - 6).format.numberFormat = "#,##0.0000";
setWidths(assumptions, [18, 22, 18, 45, 16, 14, 12, 12, 12, 12, 12, 12, 12, 12, 12, 12, 12, 12, 12, 12, 12, 12]);
assumptions.freezePanes.freezeRows(4);

setTitle(forecast, "Forecast Model", "Base deterministic v4 run. Imported model rows are values; added audit columns are formulas.");
forecast.getRangeByIndexes(3, 0, metrics.length + 1, metricHeaders.length).values = matrixFromObjects(metrics, metricHeaders);
const auditStartCol = metricHeaders.length;
forecast.getRangeByIndexes(3, auditStartCol, 1, 3).values = [["Treasury Change", "Reserve Drawdown %", "Backlog / Capacity"]];
forecast.getRangeByIndexes(4, auditStartCol, metrics.length, 3).formulas = metrics.map((_, idx) => {
  const row = idx + 5;
  const priorTreasury = idx === 0 ? "'Assumptions'!$J$5" : `${forecastCols.treasury_usd}${row - 1}`;
  return [
    `=${forecastCols.treasury_usd}${row}-${priorTreasury}`,
    `=1-${forecastCols.audience_reserve_z1u}${row}/'Assumptions'!$I$5`,
    `=IFERROR(${forecastCols.settlement_backlog_z1u}${row}/'Assumptions'!$S$5,0)`,
  ];
});
styleTable(forecast, `A4:${colLetter(auditStartCol + 2)}${4 + metrics.length}`);
forecast.getRange(`A5:A${4 + metrics.length}`).format.numberFormat = "0";
forecast.getRange(`${forecastCols.active_users}5:${forecastCols.settlement_users}${4 + metrics.length}`).format.numberFormat = "#,##0";
forecast.getRange(`${forecastCols.acr_authority_remaining}5:${forecastCols.treasury_usd}${4 + metrics.length}`).format.numberFormat = "#,##0";
forecast.getRange(`${colLetter(auditStartCol + 1)}5:${colLetter(auditStartCol + 2)}${4 + metrics.length}`).format.numberFormat = "0.0%";
forecast.freezePanes.freezeRows(4);
forecast.freezePanes.freezeColumns(1);
setWidths(forecast, [8, 14, 14, 14, 14, 14, 14, 14, 14, 14, 14, 14, 14, 16, 14, 14, 14, 14, 14, 14, 14, 16, 12, 14, 14, 14]);
const forecastChart = forecast.charts.add("line", forecast.getRange("A4:F56"));
forecastChart.title = "Active User Progression";
forecastChart.hasLegend = false;
forecastChart.xAxis = { axisType: "textAxis" };
forecastChart.yAxis = { numberFormatCode: "#,##0" };
forecastChart.setPosition("AB4", "AI20");

setTitle(risk, "Scenario Risk", "Stochastic scenario summary with Wilson confidence intervals and explicit diagnostic scenario flag.");
const riskHeaders = Object.keys(riskRows[0]);
risk.getRangeByIndexes(3, 0, riskRows.length + 1, riskHeaders.length).values = matrixFromObjects(riskRows, riskHeaders);
styleTable(risk, `A4:${String.fromCharCode(64 + riskHeaders.length)}${4 + riskRows.length}`);
risk.getRange("E5:I9").format.numberFormat = "0.0%";
risk.getRange("J5:N9").format.numberFormat = "#,##0";
risk.freezePanes.freezeRows(4);
setWidths(risk, [16, 16, 12, 10, 12, 12, 12, 12, 12, 16, 16, 18, 18, 18, 12]);

setTitle(sensitivity, "Sensitivity", "Constrained sensitivity over coupled economic families; every driver row carries imputation_used=False.");
const sensHeaders = Object.keys(sensDrivers[0]);
sensitivity.getRangeByIndexes(3, 0, sensDrivers.length + 1, sensHeaders.length).values = matrixFromObjects(sensDrivers, sensHeaders);
const rankStart = sensDrivers.length + 7;
const rankHeaders = Object.keys(rankRows[0]);
sensitivity.getRange(`A${rankStart}:J${rankStart}`).values = [rankHeaders];
sensitivity.getRangeByIndexes(rankStart, 0, rankRows.length, rankHeaders.length).values = rankRows.map((row) => rankHeaders.map((header) => row[header] ?? null));
styleTable(sensitivity, `A4:L${4 + sensDrivers.length}`);
styleTable(sensitivity, `A${rankStart}:J${rankStart + rankRows.length}`);
sensitivity.getRange(`I5:I${4 + sensDrivers.length}`).format.numberFormat = "0.0000";
sensitivity.freezePanes.freezeRows(4);
setWidths(sensitivity, [14, 20, 24, 14, 24, 16, 16, 16, 14, 12, 12, 12]);

setTitle(checks, "Checks", "Workbook and model controls. PASS means formulas and generated controls reconcile within this v4 foundation.");
checks.getRange("A4:F4").values = [["Check", "Actual", "Expected", "Difference", "Status", "Notes"]];
checks.getRange("A5:F12").values = [
  ["Overall model status", null, "OK", null, null, "Aggregates all checks below."],
  ["ACR total reconciles", reconciliation.acr_closing_total, reconciliation.acr_opening_total, null, null, "ACR typed ledger conservation check."],
  ["ACR queue ties to settlement queue", Number(reconciliation.acr_queue_matches_settlement_queue), 1, null, null, "ACR ledger queue must equal request backlog."],
  ["Z1U total reconciles", reconciliation.z1u_closing_total, reconciliation.z1u_opening_total, null, null, "Typed ledger conservation check."],
  ["USD total reconciles", reconciliation.usd_closing_total, reconciliation.usd_opening_total, null, null, "Cash ledger conservation check."],
  ["User stock reconciles", reconciliation.user_closing_total, reconciliation.user_opening_total, null, null, "User-state conservation check."],
  ["Scenario reconciliation failures", null, 0, null, null, "All stochastic runs should reconcile."],
  ["Sensitivity imputation count", null, 0, null, null, "No median imputation allowed."],
];
checks.getRange("B5").formulas = [["=IF(COUNTIF(E6:E12,\"FAIL\")=0,\"OK\",\"FAIL\")"]];
checks.getRange("D6:D10").formulas = [["=B6-C6"], ["=B7-C7"], ["=B8-C8"], ["=B9-C9"], ["=B10-C10"]];
checks.getRange("E6:E10").formulas = [["=IF(ABS(D6)<=0.0001,\"OK\",\"FAIL\")"], ["=IF(B7=C7,\"OK\",\"FAIL\")"], ["=IF(ABS(D8)<=0.0001,\"OK\",\"FAIL\")"], ["=IF(ABS(D9)<=0.0001,\"OK\",\"FAIL\")"], ["=IF(ABS(D10)<=0.0001,\"OK\",\"FAIL\")"]];
checks.getRange("B11").formulas = [["=SUM('Scenario Risk'!Q5:Q9)"]];
checks.getRange("D11").formulas = [["=B11-C11"]];
checks.getRange("E11").formulas = [["=IF(B11=C11,\"OK\",\"FAIL\")"]];
checks.getRange("B12").formulas = [["=COUNTIF('Sensitivity'!L5:L24,TRUE)"]];
checks.getRange("D12").formulas = [["=B12-C12"]];
checks.getRange("E12").formulas = [["=IF(B12=C12,\"OK\",\"FAIL\")"]];
checks.getRange("E5").formulas = [["=B5"]];
styleTable(checks, "A4:F12");
checks.getRange("B6:D11").format.numberFormat = "#,##0.0000";
setWidths(checks, [28, 18, 18, 16, 12, 50]);

setTitle(sources, "Sources Audit", "Generated artifacts and model evidence used to build this workbook.");
sources.getRange("A4:D4").values = [["Item", "Source artifact", "Refreshed", "Notes"]];
addSourceNote(sources, 5, "Pre-change audit", "MODEL_AUDIT_BEFORE_CHANGES.md", "Model map before v4 redesign.");
addSourceNote(sources, 6, "Deterministic forecast", "v4_simulation_metrics.csv", "Base v4 run generated by scripts/run_v4_decision_grade.py.");
addSourceNote(sources, 7, "Scenario definitions", "v4_scenario_definitions.csv", "Baseline, management, adverse, severe, reverse-stress.");
addSourceNote(sources, 8, "Stochastic risk", "v4_stochastic_runs.csv; v4_risk_summary.csv", "Constrained stochastic runs with no median imputation.");
addSourceNote(sources, 9, "Sensitivity", "v4_sensitivity_oat.csv; v4_sensitivity_drivers.csv; v4_sensitivity_rank_stability.csv", "Constrained OAT sensitivity and rank stability.");
addSourceNote(sources, 10, "Validation", "v4_validation_matrix.csv; V4_VALIDATION_MATRIX.md", "Conservative requirement status and residual gaps.");
styleTable(sources, "A4:D10");
sources.getRange("C5:C10").format.numberFormat = "yyyy-mm-dd";
setWidths(sources, [24, 58, 16, 70]);

for (const sheet of [cover, assumptions, forecast, risk, sensitivity, checks, sources]) {
  const used = sheet.getUsedRange();
  used.format.autofitRows();
}

await fs.mkdir(outputDir, { recursive: true });
await fs.mkdir(previewDir, { recursive: true });

const errorScan = await workbook.inspect({
  kind: "match",
  searchTerm: "#REF!|#DIV/0!|#VALUE!|#NAME\\?|#N/A",
  options: { useRegex: true, maxResults: 100 },
  summary: "formula error scan",
});
console.log(errorScan.ndjson);

for (const sheetName of ["Cover", "Assumptions", "Forecast Model", "Scenario Risk", "Sensitivity", "Checks", "Sources Audit"]) {
  const preview = await workbook.render({ sheetName, autoCrop: "all", scale: 1, format: "png" });
  await fs.writeFile(path.join(previewDir, `${sheetName.replaceAll(" ", "_")}.png`), new Uint8Array(await preview.arrayBuffer()));
}

const xlsx = await SpreadsheetFile.exportXlsx(workbook);
await xlsx.save(outputPath);
console.log(`Wrote ${outputPath}`);
