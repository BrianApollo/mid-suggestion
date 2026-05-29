import { readFileSync, writeFileSync } from "node:fs";

const FILE = process.argv[2];
const BATCH_SIZE = Number(process.argv[3] ?? 100);

if (!FILE) {
  console.error("usage: node scripts/chunk-seed.mjs <file> [batch_size]");
  process.exit(1);
}

const content = readFileSync(FILE, "utf8");

const headerMatch = content.match(/INSERT\s+INTO\s+\w+\s*\([^)]+\)\s*VALUES/i);
if (!headerMatch) {
  console.error("Could not find INSERT ... VALUES header");
  process.exit(1);
}
const header = headerMatch[0].replace(/\s+/g, " ");

const stripped = content.replace(/INSERT\s+INTO\s+\w+\s*\([^)]+\)\s*VALUES/gi, "");

const tuples = [];
let depth = 0;
let inString = false;
let inLineComment = false;
let current = "";

for (let i = 0; i < stripped.length; i++) {
  const c = stripped[i];
  const next = stripped[i + 1];

  if (inLineComment) {
    if (c === "\n") inLineComment = false;
    continue;
  }
  if (!inString && c === "-" && next === "-") {
    inLineComment = true;
    continue;
  }

  if (c === "'") {
    if (inString && next === "'") {
      if (depth > 0) current += "''";
      i++;
      continue;
    }
    inString = !inString;
    if (depth > 0) current += c;
    continue;
  }
  if (inString) {
    if (depth > 0) current += c;
    continue;
  }

  if (c === "(") {
    depth++;
    if (depth === 1) current = "(";
    else current += c;
    continue;
  }
  if (c === ")") {
    depth--;
    current += c;
    if (depth === 0) {
      tuples.push(current.replace(/\s+/g, " ").trim());
      current = "";
    }
    continue;
  }

  if (depth > 0) current += c;
}

const out = [];
for (let i = 0; i < tuples.length; i += BATCH_SIZE) {
  const batch = tuples.slice(i, i + BATCH_SIZE);
  out.push(header);
  out.push(batch.map((t) => "  " + t).join(",\n") + ";");
  out.push("");
}

writeFileSync(FILE, out.join("\n"));
console.log(
  `wrote ${tuples.length} rows in ${Math.ceil(tuples.length / BATCH_SIZE)} batches to ${FILE}`
);
