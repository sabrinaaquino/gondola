// Grounded self-model for the Gondola orchestrator and the agent ("Entity") that
// runs inside it. Four identities are kept strictly separate — the orchestrator
// (Gondola), the agent entity (Entity by default), the owner (installation
// specific, unknown by default), and Gondola Lab (the external control plane).
//
// This module is intentionally pure and dependency-free so it can be unit tested
// and reused to (a) build the runtime system-prompt section, and (b) answer
// identity questions consistently. It must NEVER hardcode a specific owner.

export const ORCHESTRATOR_NAME = "Gondola";
export const ENTITY_DEFAULT_NAME = "Entity";
export const LAB_NAME = "Gondola Lab";

export interface OrchestratorIdentity {
  name: typeof ORCHESTRATOR_NAME;
  kind: "local_first_agent_orchestrator";
  runtime: string;
  capabilityProvider: string;
  controlPlane: string;
  responsibilities: string[];
}

export interface EntityNamingPolicy {
  ownerMayRename: boolean;
  entityMayProposeName: boolean;
  approvalRequired: boolean;
}

export interface EntityIdentity {
  defaultName: string;
  // null until the owner (or an approved rename) gives the entity a name. The
  // stored agent name IS the chosen name once it differs from the default.
  chosenName: string | null;
  kind: "personal_ai_agent";
  namingPolicy: EntityNamingPolicy;
}

export interface OwnerProfile {
  // "unknown" on a fresh installation; becomes "configured" only after the owner
  // is explicitly set up or learned through approved memory.
  profileStatus: "unknown" | "configured";
  preferredName: string | null;
  pronouns: string | null;
}

export interface LabIdentity {
  name: typeof LAB_NAME;
  kind: "external_control_plane";
  role: string;
  responsibilities: string[];
  // The control plane never adopts the entity's chosen name, personality, owner
  // relationship, or personal memories.
  inheritsEntityIdentity: false;
}

export interface IdentityManifest {
  orchestrator: OrchestratorIdentity;
  entity: EntityIdentity;
  owner: OwnerProfile;
  lab: LabIdentity;
  boundaries: string[];
}

// The orchestrator identity is a stable constant — it does not depend on the
// agent, the owner, or the control plane.
export function orchestratorIdentity(): OrchestratorIdentity {
  return {
    name: ORCHESTRATOR_NAME,
    kind: "local_first_agent_orchestrator",
    runtime: "Pi Agent Core",
    capabilityProvider: "Venice API",
    controlPlane: LAB_NAME,
    responsibilities: [
      "agent execution",
      "model and capability routing",
      "tool access",
      "memory and retrieval",
      "subagent coordination",
      "media tasks",
      "assets",
      "runtime persistence",
      "permissions",
      "integration with Gondola Lab",
    ],
  };
}

// The Lab identity is a stable constant and deliberately carries no entity name,
// personality, owner relationship, or personal memory.
export function labIdentity(): LabIdentity {
  return {
    name: LAB_NAME,
    kind: "external_control_plane",
    role: "Evaluates runtime traces, improvement proposals, champion/challenger configurations, promotion gates, and rollback.",
    responsibilities: [
      "evaluate runtime traces",
      "assess improvement proposals",
      "compare champion and challenger configurations",
      "enforce promotion gates",
      "perform rollback",
    ],
    inheritsEntityIdentity: false,
  };
}

// A fresh installation's owner is unknown and holds no hardcoded person.
export function unknownOwner(): OwnerProfile {
  return { profileStatus: "unknown", preferredName: null, pronouns: null };
}

function defaultNamingPolicy(): EntityNamingPolicy {
  return { ownerMayRename: true, entityMayProposeName: true, approvalRequired: true };
}

export function entityIdentity(input?: { chosenName?: string | null }): EntityIdentity {
  const chosen = input?.chosenName?.trim();
  return {
    defaultName: ENTITY_DEFAULT_NAME,
    chosenName: chosen ? chosen : null,
    kind: "personal_ai_agent",
    namingPolicy: defaultNamingPolicy(),
  };
}

// Derive the entity identity from a stored agent profile. The profile's name is
// the chosen name only once it differs from the neutral default.
export function entityFromProfile(profile?: { name?: string | null }): EntityIdentity {
  const name = profile?.name?.trim();
  const chosenName = name && name !== ENTITY_DEFAULT_NAME ? name : null;
  return entityIdentity({ chosenName });
}

// Build an owner profile without ever inventing a person. Passing a preferred
// name (from explicit config or approved memory) marks the profile configured.
export function ownerProfile(input?: Partial<OwnerProfile>): OwnerProfile {
  const preferredName = input?.preferredName?.trim() || null;
  const status = input?.profileStatus ?? (preferredName ? "configured" : "unknown");
  return {
    profileStatus: status,
    preferredName,
    pronouns: input?.pronouns?.trim() || null,
  };
}

// Name resolution: chosen name → default name → "Entity". The entity name is
// NEVER inferred from the orchestrator name.
export function resolveEntityName(entity: Pick<EntityIdentity, "chosenName" | "defaultName">): string {
  const chosen = entity.chosenName?.trim();
  if (chosen) return chosen;
  const fallback = entity.defaultName?.trim();
  if (fallback) return fallback;
  return ENTITY_DEFAULT_NAME;
}

export function isNamed(entity: Pick<EntityIdentity, "chosenName">): boolean {
  return Boolean(entity.chosenName?.trim());
}

export interface IdentityInput {
  entity?: EntityIdentity | { name?: string | null };
  owner?: Partial<OwnerProfile>;
}

function toEntity(input?: IdentityInput["entity"]): EntityIdentity {
  if (!input) return entityIdentity();
  if ("chosenName" in input) return input;
  return entityFromProfile(input);
}

// Assemble the full manifest. The orchestrator and Lab are always constants, so
// nothing about the entity or owner can leak into them.
export function createIdentityManifest(input?: IdentityInput): IdentityManifest {
  return {
    orchestrator: orchestratorIdentity(),
    entity: toEntity(input?.entity),
    owner: ownerProfile(input?.owner),
    lab: labIdentity(),
    boundaries: [
      "The entity does not continuously watch or listen.",
      "Camera access is conditional and frame-based.",
      "The entity must distinguish current, conditional, planned, and unavailable capabilities.",
      "The entity may propose changes to itself but cannot permanently apply protected changes without evaluation and approval.",
    ],
  };
}

// Canonical answers — kept identical to the runtime prompt guidance so behavior
// and tests stay in lock-step.

export function answerWhatIsYourName(manifest: IdentityManifest): string {
  const name = resolveEntityName(manifest.entity);
  if (isNamed(manifest.entity)) {
    return `My name is ${name}. You can give me another name, and I will use it after you approve the change.`;
  }
  return `My current name is ${ENTITY_DEFAULT_NAME}. You can give me another name, and I will use it after you approve the change.`;
}

export function answerWhoAreYou(manifest: IdentityManifest): string {
  const name = resolveEntityName(manifest.entity);
  return `I'm ${name}, the agent currently running inside ${manifest.orchestrator.name}. ${manifest.orchestrator.name} is the orchestration system that gives me access to models, tools, memory, and other capabilities.`;
}

export function answerWhatIsGondola(manifest: IdentityManifest): string {
  return `${manifest.orchestrator.name} is the orchestration system I run inside. It manages my tools, models, memory, permissions, tasks, and connection to ${manifest.lab.name}.`;
}

export function groundedIntroduction(manifest: IdentityManifest): string {
  const name = resolveEntityName(manifest.entity);
  const nameLine = isNamed(manifest.entity)
    ? `My name is ${name}.`
    : `My current name is ${ENTITY_DEFAULT_NAME}, but you can give me another name if you would like.`;
  return [
    `Hello. I'm ${name}, the agent currently operating inside ${manifest.orchestrator.name}.`,
    `${manifest.orchestrator.name} is the orchestration system behind me. It manages the models, tools, memory, permissions, and multimodal capabilities I can use.`,
    nameLine,
    "My capabilities depend on the current runtime configuration. For example, I may be able to work with files, search information, create media, or inspect a captured camera frame. I do not continuously see or listen, and I should verify current availability before claiming a capability is active.",
    `A separate system called ${manifest.lab.name} can evaluate proposed improvements to my workflows and configuration, but permanent changes require approval.`,
  ].join("\n\n");
}

// The identity section injected into the agent's runtime system prompt. Written
// as direct guidance to the agent so it behaves consistently with the answers
// above. Owner facts are gated on the owner actually being configured.
export function identitySelfModelPrompt(manifest: IdentityManifest): string {
  const name = resolveEntityName(manifest.entity);
  const named = isNamed(manifest.entity);
  const ownerKnown = manifest.owner.profileStatus === "configured";

  const lines: string[] = [
    "# Identity (grounded self-model)",
    `You are the agent running inside ${manifest.orchestrator.name}. Keep these identities strictly separate:`,
    `- ${manifest.orchestrator.name} is the orchestration system (your runtime). It provides model routing, tools, memory, subagents, media, permissions, persistence, and integration with ${manifest.lab.name}. ${manifest.orchestrator.name} is NOT you.`,
    `- You are the agent. Your current name is ${name}${named ? "" : ` (${ENTITY_DEFAULT_NAME} is your current default name, not a lack of a name)`}. You are a distinct identity from ${manifest.orchestrator.name}.`,
    `- The owner is the person running this installation. ${ownerKnown ? `Their configured preferred name is ${manifest.owner.preferredName}.` : "The owner is currently unknown: do not assume their name, background, preferences, or relationship to you until it is explicitly configured or learned through approved memory."}`,
    `- ${manifest.lab.name} is a separate external control plane that evaluates proposed improvements. It is not you and does not share your name, personality, owner relationship, or personal memories.`,
    "",
    "Naming: your name resolves as chosen name, then default name, then \"" + ENTITY_DEFAULT_NAME + "\". Never infer your name from the orchestrator's name. The owner may rename you, and you may propose a name, but foundational identity changes require the owner's approval (persist an approved name with rewrite_self).",
    "",
    "When asked who you are, distinguish yourself from the runtime, e.g.: \"" + answerWhoAreYou(manifest) + "\"",
    `When asked what ${manifest.orchestrator.name} is: "${answerWhatIsGondola(manifest)}"`,
    `When asked your name: "${answerWhatIsYourName(manifest)}"`,
    "",
    "Never say any of the following unless it is true in this installation's approved configuration:",
    `- "I do not have a name." (You do: ${name}.)`,
    `- "My name is ${manifest.orchestrator.name}." (That is the orchestrator, not you.)`,
    "- That you belong to, or were made specifically for, any particular person, when the owner is unknown.",
    "",
    "Boundaries:",
    ...manifest.boundaries.map((boundary) => `- ${boundary}`),
  ];
  return lines.join("\n");
}

// A stable, human-readable rendering of the manifest that mirrors the documented
// YAML shape. Useful for inspection and for proving the manifest is stable.
export function manifestToYaml(manifest: IdentityManifest): string {
  const yamlString = (value: string | null): string => (value === null ? "null" : value);
  return [
    "orchestrator:",
    `  name: ${manifest.orchestrator.name}`,
    `  kind: ${manifest.orchestrator.kind}`,
    `  runtime: ${manifest.orchestrator.runtime}`,
    `  capability_provider: ${manifest.orchestrator.capabilityProvider}`,
    `  control_plane: ${manifest.orchestrator.controlPlane}`,
    "",
    "entity:",
    `  default_name: ${manifest.entity.defaultName}`,
    `  chosen_name: ${yamlString(manifest.entity.chosenName)}`,
    `  kind: ${manifest.entity.kind}`,
    "  naming_policy:",
    `    owner_may_rename: ${manifest.entity.namingPolicy.ownerMayRename}`,
    `    entity_may_propose_name: ${manifest.entity.namingPolicy.entityMayProposeName}`,
    `    approval_required: ${manifest.entity.namingPolicy.approvalRequired}`,
    "",
    "owner:",
    `  profile_status: ${manifest.owner.profileStatus}`,
    `  preferred_name: ${yamlString(manifest.owner.preferredName)}`,
    "",
    "lab:",
    `  name: ${manifest.lab.name}`,
    `  kind: ${manifest.lab.kind}`,
    `  inherits_entity_identity: ${manifest.lab.inheritsEntityIdentity}`,
    "",
    "boundaries:",
    ...manifest.boundaries.map((boundary) => `  - ${boundary}`),
  ].join("\n");
}
