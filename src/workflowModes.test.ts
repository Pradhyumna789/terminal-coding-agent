import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ensureMermaidDiagram,
  GENERATED_DOCS_PATH,
  verifyGeneratedDocs,
  writeGeneratedDocs,
} from "./docsMode.js";
import { runDoneCriteria } from "./doneCriteria.js";
import { buildSpecPrompt } from "./specFirst.js";
import { buildTddPrompt, TDD_AGENT_MAX_STEPS } from "./tddMode.js";

test("spec-first prompt is non-mutating and tool-free", () => {
  const prompt = buildSpecPrompt("Add a Format tool");

  assert.match(prompt, /Do not modify files/);
  assert.match(prompt, /Do not call tools/);
});

test("TDD mode keeps unlimited max steps", () => {
  assert.equal(TDD_AGENT_MAX_STEPS, null);
  assert.match(buildTddPrompt("Add a helper"), /Create or update tests before implementation/);
});

test("docs workflow ensures Mermaid and verifies generated markdown", async () => {
  const markdown = ensureMermaidDiagram("# Architecture\n\nGenerated docs.", "agent loop");

  assert.match(markdown, /```mermaid/);

  await writeGeneratedDocs(markdown);
  const summary = await verifyGeneratedDocs();

  assert.match(summary, new RegExp(GENERATED_DOCS_PATH.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("done criteria runs tests when a test script exists", async () => {
  const result = await runDoneCriteria("final summary", {
    requireTypeCheck: false,
    requireTestsIfAvailable: true,
    requireFinalSummary: true,
    testCommand: "node --version",
  });
  const testsCheck = result.checks.find((check) => check.name === "Tests");

  assert.ok(testsCheck);
  assert.equal(testsCheck.skipped, false);
  assert.equal(testsCheck.passed, true);
});
