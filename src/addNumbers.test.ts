import { test } from "node:test";
import assert from "node:assert";
import { addNumbers } from "./addNumbers.js";

test("addNumbers should add two positive numbers", () => {
  assert.strictEqual(addNumbers(2, 3), 5);
});

test("addNumbers should add negative numbers", () => {
  assert.strictEqual(addNumbers(-1, -1), -2);
});

test("addNumbers should add positive and negative numbers", () => {
  assert.strictEqual(addNumbers(5, -3), 2);
});

test("addNumbers should handle zero", () => {
  assert.strictEqual(addNumbers(0, 0), 0);
  assert.strictEqual(addNumbers(5, 0), 5);
});

test("addNumbers should handle decimal numbers", () => {
  assert.strictEqual(addNumbers(1.5, 2.5), 4);
});
