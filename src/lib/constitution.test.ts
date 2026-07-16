import assert from "node:assert/strict";
import { test } from "node:test";
import {
  GONDOLA_PURPOSE,
  gondolaConstitution,
  renderArchitectureAnswer,
  renderConstitutionPrompt,
} from "./constitution";

test("the constitution states the purpose and non-empty principles/roles/subsystems", () => {
  const constitution = gondolaConstitution();
  assert.equal(constitution.purpose, GONDOLA_PURPOSE);
  assert.ok(constitution.purpose.includes("operational intelligence"));
  assert.ok(constitution.principles.length >= 4);
  assert.ok(constitution.roles.length >= 5);
  assert.ok(constitution.subsystems.length >= 5);
});

test("the constitution defines the five distinct roles", () => {
  const roles = gondolaConstitution().roles.map((role) => role.role);
  for (const expected of ["Entity", "Supervisor", "Gondola Lab", "Runtime", "Human"]) {
    assert.ok(roles.includes(expected), `missing role ${expected}`);
  }
});

test("every role carries both a responsibility and a boundary", () => {
  for (const role of gondolaConstitution().roles) {
    assert.ok(role.responsibility.length > 0, `${role.role} responsibility`);
    assert.ok(role.boundary.length > 0, `${role.role} boundary`);
  }
});

test("renderConstitutionPrompt leads with purpose and points to the runtime for authority", () => {
  const prompt = renderConstitutionPrompt();
  assert.ok(prompt.includes(GONDOLA_PURPOSE));
  assert.ok(prompt.includes("Entity"));
  assert.ok(/runtime_status/.test(prompt));
  assert.ok(/runtime answers first/i.test(prompt));
});

test("renderArchitectureAnswer includes roles and subsystems", () => {
  const answer = renderArchitectureAnswer();
  assert.ok(answer.includes(GONDOLA_PURPOSE));
  assert.ok(answer.includes("Runtime introspection"));
  assert.ok(answer.includes("Gondola Lab"));
});
