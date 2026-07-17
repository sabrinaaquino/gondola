"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ApprovalPolicy } from "@/lib/app-types";

// First-run onboarding gate. Rendered instead of the workspace until setup is
// verified "ready". Talks only to the local /api/setup/* routes; the credential
// lives in component state only for the submission lifecycle and is cleared as
// soon as the request resolves. It never touches localStorage or chat state.

interface CredentialStatusView {
  configured: boolean;
  source: "environment" | "file" | "none";
  maskedSuffix: string | null;
  hasEnv: boolean;
  hasFile: boolean;
  envReadOnly: boolean;
}

export interface SetupStatusView {
  state:
    | "not_configured"
    | "credential_detected"
    | "verifying"
    | "invalid_credential"
    | "inference_failed"
    | "unreachable"
    | "ready"
    | "repair_required";
  providerId: string;
  provider: { id: string; name: string; keyManagementUrl: string };
  credential: CredentialStatusView;
  verifiedAt?: string;
  defaultChatModel?: string;
  capabilities?: Record<string, boolean>;
  routes?: Record<string, { capability: string; providerId: string; modelId: string }>;
  message?: string;
  reason?: string;
}

type Screen = "welcome" | "connect" | "credential" | "capabilities" | "permissions";

const CAPABILITY_LABELS: Array<{ key: string; label: string; blurb: string }> = [
  { key: "chat", label: "Conversation", blurb: "Natural back-and-forth chat" },
  { key: "reasoning", label: "Reasoning", blurb: "Step-by-step problem solving" },
  { key: "vision", label: "Vision", blurb: "Understands images and the camera" },
  { key: "search", label: "Search", blurb: "Private live web search" },
  { key: "transcription", label: "Transcription", blurb: "Speech to text" },
  { key: "speech", label: "Speech", blurb: "Natural spoken replies" },
  { key: "image", label: "Images", blurb: "Generates pictures" },
  { key: "video", label: "Video", blurb: "Generates short video" },
  { key: "music", label: "Music", blurb: "Generates music and audio" },
  { key: "embedding", label: "Embeddings", blurb: "Memory and file understanding" },
];

const INTRO_PROMPT = "Introduce yourself and tell me what you can help me do.";

function recoveryGuidance(status: SetupStatusView): string {
  if (status.message) return status.message;
  switch (status.reason) {
    case "no_credits":
      return "This key has no available credits. Add credits in your Venice account, then verify again.";
    case "unreachable":
      return "Gondola couldn't reach Venice. Check your internet connection and try again.";
    default:
      if (status.state === "inference_failed") {
        return "The key was accepted but a test message failed. Try again; if it persists, check Venice status.";
      }
      return "Venice rejected this key. Double-check you pasted the full inference key.";
  }
}

export function Onboarding({ initialStatus, onReady }: { initialStatus?: SetupStatusView; onReady: () => void }) {
  const [screen, setScreen] = useState<Screen>("welcome");
  const [status, setStatus] = useState<SetupStatusView | undefined>(initialStatus);
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const abortRef = useRef<AbortController | null>(null);

  // Permissions. File + terminal default OFF; terminal requires file access.
  const [fileAccess, setFileAccess] = useState(false);
  const [shellAccess, setShellAccess] = useState(false);
  const [confirmation, setConfirmation] = useState<ApprovalPolicy>("risk_based");

  useEffect(() => {
    if (initialStatus) return;
    let cancelled = false;
    void fetch("/api/setup/status", { cache: "no-store" })
      .then((response) => response.json())
      .then((body: SetupStatusView) => {
        if (!cancelled) setStatus(body);
      })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, [initialStatus]);

  useEffect(() => () => abortRef.current?.abort(), []);

  const applyStatus = useCallback((next: SetupStatusView) => {
    setStatus(next);
    if (next.state === "ready") setScreen("capabilities");
    else setError(recoveryGuidance(next));
  }, []);

  const submitKey = useCallback(async () => {
    const trimmed = apiKey.trim();
    if (!trimmed) { setError("Paste your Venice API key to continue."); return; }
    setBusy(true);
    setError("");
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const response = await fetch("/api/setup/credentials", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apiKey: trimmed }),
        signal: controller.signal,
      });
      const body = (await response.json()) as SetupStatusView;
      applyStatus(body);
    } catch (submitError) {
      if (!(submitError instanceof Error && submitError.name === "AbortError")) {
        setError("Gondola couldn't reach Venice. Check your connection and try again.");
      }
    } finally {
      // Never keep the credential in state beyond the submission lifecycle.
      setApiKey("");
      setBusy(false);
      abortRef.current = null;
    }
  }, [apiKey, applyStatus]);

  const useEnvCredential = useCallback(async () => {
    setBusy(true);
    setError("");
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const response = await fetch("/api/setup/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
        signal: controller.signal,
      });
      const body = (await response.json()) as SetupStatusView;
      applyStatus(body);
    } catch (verifyError) {
      if (!(verifyError instanceof Error && verifyError.name === "AbortError")) {
        setError("Gondola couldn't reach Venice. Check your connection and try again.");
      }
    } finally {
      setBusy(false);
      abortRef.current = null;
    }
  }, [applyStatus]);

  const cancelVerify = useCallback(() => {
    abortRef.current?.abort();
    setBusy(false);
    setError("Verification cancelled.");
  }, []);

  const finish = useCallback(() => {
    // Terminal access implies file access; never persist shell without file.
    const shell = fileAccess && shellAccess;
    try {
      const savedSettings = JSON.parse(localStorage.getItem("nova-settings") ?? "{}") as Record<string, unknown>;
      localStorage.setItem("nova-settings", JSON.stringify({ ...savedSettings, fileAccess, shellAccess: shell, approvalPolicy: confirmation, persistentTasks: true }));
      localStorage.setItem(
        "nova-onboarding-permissions",
        JSON.stringify({ fileAccess, shellAccess: shell, confirmationPolicy: confirmation }),
      );
      // Signals the workspace to auto-submit the first message on entry, so the
      // real agent turn (not a confirmation screen) completes onboarding.
      localStorage.setItem("nova-onboarding-intro", INTRO_PROMPT);
    } catch {
      // localStorage may be unavailable; onboarding still completes.
    }
    onReady();
  }, [confirmation, fileAccess, onReady, shellAccess]);

  const provider = status?.provider;
  const keyUrl = provider?.keyManagementUrl ?? "https://venice.ai/settings/api";
  const envDetected = Boolean(status?.credential.hasEnv);

  return (
    <div className="onb-root">
      <div className="onb-card">
        <div className="onb-progress" aria-hidden="true">
          {(["welcome", "connect", "credential", "capabilities", "permissions"] as Screen[]).map((step) => (
            <span key={step} className={`onb-dot ${screen === step ? "is-active" : ""}`} />
          ))}
        </div>

        {screen === "welcome" && (
          <section className="onb-screen">
            <span className="onb-badge">Gondola</span>
            <h1>Meet Gondola</h1>
            <p className="onb-lead">Gondola is a personal AI agent that can speak, see, search, remember, create, use tools, and improve its workflows.</p>
            <button className="onb-primary" onClick={() => setScreen("connect")}>Set up Gondola</button>
          </section>
        )}

        {screen === "connect" && (
          <section className="onb-screen">
            <h1>Unlock the complete Gondola experience</h1>
            <p className="onb-lead">One Venice API key gives Gondola access to models for reasoning, vision, search, speech, transcription, images, video, music, and embeddings.</p>
            <ul className="onb-points">
              <li>Your key stays on this machine.</li>
              <li>You control what Gondola can access.</li>
              <li>You can override individual model roles later.</li>
            </ul>
            <button className="onb-primary" onClick={() => setScreen("credential")}>Connect Venice</button>
            <button className="onb-link" onClick={() => setScreen("welcome")}>Back</button>
          </section>
        )}

        {screen === "credential" && (
          <section className="onb-screen">
            <h1>Connect your Venice key</h1>
            <p className="onb-lead">Paste your Venice inference key. Gondola verifies it with a live model check and a quick test message before saving it locally.</p>

            {envDetected && (
              <div className="onb-env">
                <div>
                  <strong>Environment key detected</strong>
                  <small>A Venice key is already configured for this machine{status?.credential.maskedSuffix ? ` (${status.credential.maskedSuffix})` : ""}.</small>
                </div>
                <button className="onb-secondary" disabled={busy} onClick={() => void useEnvCredential()}>Use it</button>
              </div>
            )}

            <label className="onb-field">
              <span>Venice API key</span>
              <input
                type="password"
                autoComplete="off"
                spellCheck={false}
                placeholder="Venice inference key"
                value={apiKey}
                disabled={busy}
                onChange={(event) => setApiKey(event.target.value)}
                onKeyDown={(event) => { if (event.key === "Enter") void submitKey(); }}
              />
            </label>
            <a className="onb-keylink" href={keyUrl} target="_blank" rel="noreferrer">Create or manage a Venice API key →</a>

            {error && <p className="onb-error" role="alert">{error}</p>}
            {busy && <p className="onb-progress-text">Verifying with Venice…</p>}

            <div className="onb-actions">
              {busy
                ? <button className="onb-secondary" onClick={cancelVerify}>Cancel</button>
                : <button className="onb-link" onClick={() => setScreen("connect")}>Back</button>}
              <button className="onb-primary" disabled={busy || !apiKey.trim()} onClick={() => void submitKey()}>Verify</button>
            </div>
          </section>
        )}

        {screen === "capabilities" && (
          <section className="onb-screen">
            <h1>Gondola is connected</h1>
            <p className="onb-lead">Venice is verified{status?.credential.maskedSuffix ? ` (${status.credential.maskedSuffix})` : ""}. Here's what's ready, detected from your live model catalog. You can override any model role later.</p>
            <div className="onb-caps">
              {CAPABILITY_LABELS.map(({ key, label, blurb }) => {
                const ready = Boolean(status?.capabilities?.[key]);
                return (
                  <div key={key} className={`onb-cap ${ready ? "is-ready" : "is-off"}`}>
                    <span className="onb-cap-dot" aria-hidden="true" />
                    <span className="onb-cap-text"><strong>{label}</strong><small>{ready ? blurb : "Not available on this account"}</small></span>
                  </div>
                );
              })}
            </div>
            <button className="onb-primary" onClick={() => setScreen("permissions")}>Continue</button>
          </section>
        )}

        {screen === "permissions" && (
          <section className="onb-screen">
            <h1>Choose what Gondola can do</h1>
            <p className="onb-lead">You're in control. File and terminal access stay off until you turn them on. Camera and microphone are requested only when you first use them.</p>

            <div className="onb-toggle-group">
              <label className="onb-toggle">
                <input
                  type="checkbox"
                  checked={fileAccess}
                  onChange={(event) => {
                    const enabled = event.target.checked;
                    setFileAccess(enabled);
                    if (!enabled) setShellAccess(false);
                  }}
                />
                <span><strong>File access</strong><small>Let Gondola read and edit files in the workspace</small></span>
              </label>
              <label className={`onb-toggle ${fileAccess ? "" : "is-disabled"}`}>
                <input
                  type="checkbox"
                  checked={fileAccess && shellAccess}
                  disabled={!fileAccess}
                  onChange={(event) => setShellAccess(event.target.checked)}
                />
                <span><strong>Terminal access</strong><small>{fileAccess ? "Let Gondola run commands" : "Requires file access"}</small></span>
              </label>
            </div>

            <label className="onb-field">
              <span>Confirmation policy</span>
              <select value={confirmation} onChange={(event) => setConfirmation(event.target.value as ApprovalPolicy)}>
                <option value="risk_based">Ask only for risky actions</option>
                <option value="always_ask">Always ask</option>
                <option value="always_allow">Always allow</option>
                <option value="never_allow">Never allow changes</option>
              </select>
              <small className="onb-note">Protected credentials and sandbox boundaries stay enforced in every mode. You can change this policy later.</small>
            </label>

            <div className="onb-actions">
              <button className="onb-link" onClick={() => setScreen("capabilities")}>Back</button>
              <button className="onb-primary" onClick={finish}>Enter Gondola</button>
            </div>
          </section>
        )}
      </div>
    </div>
  );
}
