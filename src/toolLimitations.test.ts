import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { parseTypeScriptDiagnostics } from "./diagnostics/typescriptDiagnostics.js";
import { searchFilesTool } from "./tools/searchFilesTool.js";
import { writeTool } from "./tools/writeTool.js";

test("SearchFiles still finds files by filename", async () => {
  const result = await searchFilesTool("traceLogger.ts");

  assert.match(result, /src\/traceLogger\.ts \[file\]/);
});

test("SearchFiles can search text with snippets and max results", async () => {
  const result = await searchFilesTool("redactSecretValues", {
    searchText: true,
    maxResults: 2,
  });
  const lines = result.split("\n").filter(Boolean);

  assert.ok(lines.length <= 2);
  assert.match(result, /\[text\]/);
});

test("SearchFiles ignores generated and runtime directories", async () => {
  const runsDirectory = join(process.cwd(), "runs");
  const marker = ["runtime", "ignore", "marker", String(Date.now())].join("-");

  await mkdir(runsDirectory, { recursive: true });
  await writeFile(join(runsDirectory, "search-ignore-marker.txt"), marker, "utf-8");

  const result = await searchFilesTool(marker, { searchText: true });

  assert.equal(result, `No files matched query: ${marker}`);
});

test("Write creates parent directories and reports create versus overwrite", async () => {
  const root = join(process.cwd(), "tmp-tool-tests");

  await rm(root, { force: true, recursive: true });

  try {
    const firstResult = await writeTool("tmp-tool-tests/nested/example.txt", "hello");
    const secondResult = await writeTool("tmp-tool-tests/nested/example.txt", "hello again");

    assert.equal(firstResult, "Created file: tmp-tool-tests/nested/example.txt");
    assert.equal(secondResult, "Overwrote file: tmp-tool-tests/nested/example.txt");
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("Write blocks outside project paths", async () => {
  await assert.rejects(() => writeTool("../outside-write.txt", "blocked"), /outside project root/);
});

test("TypeScript diagnostics parse code and multiline context", () => {
  const output = `src/example.ts:4:7 - error TS2322: Type 'string' is not assignable to type 'number'.

4 const value: number = "x";
        ~~~~~

Found 1 error in src/example.ts:4`;
  const diagnostics = parseTypeScriptDiagnostics(output);

  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0].filePath, "src/example.ts");
  assert.equal(diagnostics[0].code, "TS2322");
  assert.match(diagnostics[0].context ?? "", /const value/);
});

test("TypeScript diagnostics return empty when no errors exist", () => {
  assert.deepEqual(parseTypeScriptDiagnostics("No errors."), []);
});
