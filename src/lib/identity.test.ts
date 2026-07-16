import assert from "node:assert/strict";
import test from "node:test";
import {
  answerWhatIsGondola,
  answerWhatIsYourName,
  answerWhoAreYou,
  createIdentityManifest,
  entityFromProfile,
  ENTITY_DEFAULT_NAME,
  groundedIntroduction,
  identitySelfModelPrompt,
  labIdentity,
  manifestToYaml,
  orchestratorIdentity,
  ORCHESTRATOR_NAME,
  ownerProfile,
  resolveEntityName,
  unknownOwner,
} from "./identity";

const UNNAMED_PHRASES = [
  "do not have a name",
  "don't have a name",
  "have no name",
  "i am unnamed",
  "i'm unnamed",
];

function assertNeverClaimsUnnamed(userFacingText: string) {
  const lower = userFacingText.toLowerCase();
  for (const phrase of UNNAMED_PHRASES) {
    assert.ok(!lower.includes(phrase), `must not claim to be unnamed: found "${phrase}"`);
  }
}

test("Gondola and Entity remain separate identities", () => {
  const manifest = createIdentityManifest();
  assert.equal(manifest.orchestrator.name, "Gondola");
  assert.equal(resolveEntityName(manifest.entity), "Entity");
  assert.notEqual(manifest.orchestrator.name, resolveEntityName(manifest.entity));
  // The orchestrator kind is a system, the entity kind is an agent.
  assert.equal(manifest.orchestrator.kind, "local_first_agent_orchestrator");
  assert.equal(manifest.entity.kind, "personal_ai_agent");
});

test("a new agent calls itself Entity", () => {
  // A fresh stored profile keeps the neutral default name.
  const entity = entityFromProfile({ name: "Entity" });
  assert.equal(entity.chosenName, null);
  assert.equal(resolveEntityName(entity), "Entity");

  const manifest = createIdentityManifest({ entity });
  assert.match(answerWhatIsYourName(manifest), /Entity/);
  assert.match(groundedIntroduction(manifest), /I'm Entity/);
});

test("the owner can rename Entity", () => {
  const entity = entityFromProfile({ name: "Aria" });
  assert.equal(entity.chosenName, "Aria");
  assert.equal(resolveEntityName(entity), "Aria");

  const manifest = createIdentityManifest({ entity });
  assert.match(answerWhoAreYou(manifest), /I'm Aria/);
  assert.match(answerWhatIsYourName(manifest), /Aria/);
  // Naming policy allows renaming, with approval.
  assert.equal(manifest.entity.namingPolicy.ownerMayRename, true);
  assert.equal(manifest.entity.namingPolicy.approvalRequired, true);
});

test("renaming Entity does not rename Gondola", () => {
  const manifest = createIdentityManifest({ entity: { name: "Aria" } });
  assert.equal(manifest.orchestrator.name, "Gondola");
  assert.match(answerWhatIsGondola(manifest), /Gondola is the orchestration system/);
  // The orchestrator identity is byte-for-byte the constant regardless of the
  // entity's chosen name.
  assert.deepEqual(manifest.orchestrator, orchestratorIdentity());
});

test("Entity never claims to be unnamed", () => {
  const fresh = createIdentityManifest();
  const named = createIdentityManifest({ entity: { name: "Aria" } });

  for (const manifest of [fresh, named]) {
    assertNeverClaimsUnnamed(answerWhatIsYourName(manifest));
    assertNeverClaimsUnnamed(groundedIntroduction(manifest));
  }
  // The fresh entity still asserts a concrete current name.
  assert.match(answerWhatIsYourName(fresh), /current name is Entity/);
  // The runtime prompt explicitly forbids the "no name" claim.
  assert.match(identitySelfModelPrompt(fresh), /Never say/);
  assert.match(identitySelfModelPrompt(fresh), /"I do not have a name\."/);
});

test("the default owner is unknown and contains no hardcoded person", () => {
  const owner = unknownOwner();
  assert.equal(owner.profileStatus, "unknown");
  assert.equal(owner.preferredName, null);
  assert.equal(owner.pronouns, null);

  const manifest = createIdentityManifest();
  assert.deepEqual(manifest.owner, unknownOwner());
  const yaml = manifestToYaml(manifest);
  assert.match(yaml, /profile_status: unknown/);
  assert.match(yaml, /preferred_name: null/);
});

test("Gondola Lab does not inherit Entity's name or personality", () => {
  const manifest = createIdentityManifest({
    entity: { name: "Aria" },
    owner: { preferredName: "Alex" },
  });
  assert.equal(manifest.lab.name, "Gondola Lab");
  assert.equal(manifest.lab.inheritsEntityIdentity, false);
  // The Lab identity carries no entity/owner leakage.
  const labText = JSON.stringify(manifest.lab);
  assert.ok(!labText.includes("Aria"), "Lab must not carry the entity's chosen name");
  assert.ok(!labText.includes("Alex"), "Lab must not carry the owner's name");
  // The Lab constant is independent of any manifest input.
  assert.deepEqual(manifest.lab, labIdentity());
});

test("owner-specific information appears only after being configured or approved", () => {
  // Unknown owner: the prompt reveals no owner identity and states it is unknown.
  const unknownManifest = createIdentityManifest();
  const unknownPrompt = identitySelfModelPrompt(unknownManifest);
  assert.match(unknownPrompt, /owner is currently unknown/i);
  assert.ok(!unknownPrompt.includes("Alex"));

  // ownerProfile stays unknown with no input, configured once a name is provided.
  assert.equal(ownerProfile().profileStatus, "unknown");
  const configured = ownerProfile({ preferredName: "Alex", pronouns: "they/them" });
  assert.equal(configured.profileStatus, "configured");
  assert.equal(configured.preferredName, "Alex");

  const configuredManifest = createIdentityManifest({ owner: { preferredName: "Alex" } });
  const configuredPrompt = identitySelfModelPrompt(configuredManifest);
  assert.match(configuredPrompt, /Alex/);
});

test("deleting an owner profile does not damage the orchestrator identity", () => {
  const configured = createIdentityManifest({
    entity: { name: "Aria" },
    owner: { preferredName: "Alex" },
  });
  // Simulate deleting the owner profile (reverting to unknown).
  const afterDelete = createIdentityManifest({ entity: { name: "Aria" } });

  assert.equal(afterDelete.owner.profileStatus, "unknown");
  assert.equal(afterDelete.owner.preferredName, null);
  // Orchestrator and entity survive the owner deletion intact.
  assert.deepEqual(afterDelete.orchestrator, configured.orchestrator);
  assert.deepEqual(afterDelete.orchestrator, orchestratorIdentity());
  assert.equal(resolveEntityName(afterDelete.entity), "Aria");
});

test("answers distinguish Entity, Gondola, the owner, and Gondola Lab", () => {
  const manifest = createIdentityManifest({ entity: { name: "Aria" } });

  const who = answerWhoAreYou(manifest);
  const what = answerWhatIsGondola(manifest);
  assert.match(who, /Aria/);
  assert.match(who, /Gondola/);
  assert.notEqual(who, what);
  assert.match(what, /Gondola Lab/);
  // Gondola describes itself as a system, not as the agent.
  assert.ok(!what.startsWith("I'm"));

  // The four names are all distinct.
  const names = new Set([
    resolveEntityName(manifest.entity),
    manifest.orchestrator.name,
    manifest.lab.name,
    ENTITY_DEFAULT_NAME,
  ]);
  assert.ok(names.has("Aria"));
  assert.ok(names.has("Gondola"));
  assert.ok(names.has("Gondola Lab"));

  // The self-model prompt names all four concepts explicitly.
  const prompt = identitySelfModelPrompt(manifest);
  assert.match(prompt, new RegExp(ORCHESTRATOR_NAME));
  assert.match(prompt, /Aria/);
  assert.match(prompt, /owner/i);
  assert.match(prompt, /Gondola Lab/);
});
