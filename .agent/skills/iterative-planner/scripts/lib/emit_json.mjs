// emit_json.mjs - synchronous JSON emission for pipe-safe CLI output.

import { writeSync } from "fs";

export function writeAllSync(fd, value) {
  const buffer = Buffer.isBuffer(value) ? value : Buffer.from(String(value), "utf-8");
  let offset = 0;
  while (offset < buffer.length) {
    const written = writeSync(fd, buffer, offset, buffer.length - offset);
    if (written <= 0) {
      throw new Error(`writeSync wrote ${written} bytes while ${buffer.length - offset} remained`);
    }
    offset += written;
  }
  return buffer.length;
}

export function emitJson(value, { fd = 1, space = 2 } = {}) {
  return writeAllSync(fd, `${JSON.stringify(value, null, space)}\n`);
}
