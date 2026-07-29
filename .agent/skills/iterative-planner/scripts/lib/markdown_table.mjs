// markdown_table.mjs — Shared markdown table parsing for planner proof artifacts.

function countBacktickRun(value, start) {
  let end = start;
  while (end < value.length && value[end] === "`") end += 1;
  return end - start;
}

function trimOuterDelimiter(value) {
  let text = String(value || "").trim();
  if (text.startsWith("|")) text = text.slice(1);
  if (text.endsWith("|")) text = text.slice(0, -1);
  return text;
}

export function splitMarkdownTableRow(line, { trimCells = true } = {}) {
  const text = trimOuterDelimiter(line);
  const cells = [];
  let cell = "";
  let inCode = false;
  let codeFence = 0;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];

    if (char === "\\" && next === "|") {
      cell += "|";
      index += 1;
      continue;
    }

    if (char === "`") {
      const run = countBacktickRun(text, index);
      const ticks = "`".repeat(run);
      if (!inCode) {
        inCode = true;
        codeFence = run;
      } else if (run === codeFence) {
        inCode = false;
        codeFence = 0;
      }
      cell += ticks;
      index += run - 1;
      continue;
    }

    if (char === "|" && !inCode) {
      cells.push(trimCells ? cell.trim() : cell);
      cell = "";
      continue;
    }

    cell += char;
  }

  cells.push(trimCells ? cell.trim() : cell);
  return cells;
}

export function isMarkdownTableSeparatorRow(line) {
  if (!String(line || "").includes("|")) return false;
  const cells = splitMarkdownTableRow(line);
  if (cells.length < 2) return false;
  return cells.every((cell) => {
    const value = String(cell || "").trim();
    return value === "" || /^:?-{3,}:?$/.test(value);
  });
}

export function parseMarkdownTable(sectionContent, { sourceLine = 1 } = {}) {
  const tableLines = String(sectionContent || "")
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((raw, offset) => ({
      raw,
      line_number: sourceLine + offset,
      trimmed: raw.trim(),
    }))
    .filter((entry) => entry.trimmed.startsWith("|"));

  if (tableLines.length < 2) {
    return { header: null, rows: [], row_objects: [], malformed_rows: [] };
  }

  const dataRows = tableLines.filter((entry) => !isMarkdownTableSeparatorRow(entry.trimmed));
  if (dataRows.length === 0) {
    return { header: null, rows: [], row_objects: [], malformed_rows: [] };
  }

  const header = splitMarkdownTableRow(dataRows[0].trimmed);
  const rowObjects = [];
  const malformedRows = [];

  for (const [index, entry] of dataRows.slice(1).entries()) {
    const cells = splitMarkdownTableRow(entry.trimmed);
    const row = {
      index: index + 1,
      line_number: entry.line_number,
      raw: entry.raw,
      cells,
      malformed: cells.length !== header.length,
      expected_cells: header.length,
      actual_cells: cells.length,
    };
    if (row.malformed) malformedRows.push(row);
    rowObjects.push(row);
  }

  return {
    header,
    rows: rowObjects.map((row) => row.cells),
    row_objects: rowObjects,
    malformed_rows: malformedRows,
  };
}
