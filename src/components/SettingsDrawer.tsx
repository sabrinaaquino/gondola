import { useEffect, useMemo, useState } from "react";
import type { AgentSettings, CatalogModel } from "@/lib/app-types";
import { CameraIcon, CloseIcon, PlugIcon, SparkleIcon, VolumeIcon } from "./Icons";

const VOICE_PROFILES = [
  { id: "natural-male", label: "Natural male", detail: "Warm and grounded", model: "tts-xai-v1", voice: "rex" },
  { id: "natural-female", label: "Natural female", detail: "Clear and bright", model: "tts-xai-v1", voice: "eve" },
  { id: "expressive-male", label: "Expressive male", detail: "Emotion directed", model: "tts-qwen3-1-7b", voice: "Dylan" },
  { id: "expressive-female", label: "Expressive female", detail: "Emotion directed", model: "tts-qwen3-1-7b", voice: "Serena" },
] as const;

type SettingsCategory = "voice" | "behavior" | "models" | "connection";

const CATEGORIES: { id: SettingsCategory; label: string; hint: string }[] = [
  { id: "voice", label: "Voice", hint: "Sound and delivery" },
  { id: "behavior", label: "Camera and behavior", hint: "Awareness and web" },
  { id: "models", label: "Models", hint: "Venice routing" },
  { id: "connection", label: "Connection", hint: "Privacy and status" },
];

interface SettingsDrawerProps {
  open: boolean;
  onClose: () => void;
  settings: AgentSettings;
  onChange: (settings: AgentSettings) => void;
  models: CatalogModel[];
  connected: boolean;
  onPreviewVoice: () => void;
}

function CategoryIcon({ id }: { id: SettingsCategory }) {
  if (id === "voice") return <VolumeIcon size={17} />;
  if (id === "behavior") return <CameraIcon size={17} />;
  if (id === "models") return <SparkleIcon size={17} />;
  return <PlugIcon size={17} />;
}

function ModelSelect({
  label,
  hint,
  value,
  models,
  onChange,
}: {
  label: string;
  hint: string;
  value: string;
  models: CatalogModel[];
  onChange: (value: string) => void;
}) {
  return (
    <label className="settings-field">
      <span className="field-heading">
        <span>{label}</span>
        <small>{hint}</small>
      </span>
      <span className="select-wrap">
        <select value={value} onChange={(event) => onChange(event.target.value)}>
          {!models.some((model) => model.id === value) && <option value={value}>{value}</option>}
          {models.map((model) => (
            <option key={model.id} value={model.id}>
              {model.name}{model.privacy === "private" ? " · private" : ""}
            </option>
          ))}
        </select>
      </span>
    </label>
  );
}

export function SettingsDrawer({
  open,
  onClose,
  settings,
  onChange,
  models,
  connected,
  onPreviewVoice,
}: SettingsDrawerProps) {
  const [category, setCategory] = useState<SettingsCategory>("voice");

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  const groups = useMemo(() => {
    const byType = (type: string) => models.filter((model) => model.type === type);
    return {
      chat: byType("text").filter((model) => model.capabilities?.supportsFunctionCalling === true),
      vision: byType("text").filter((model) => model.capabilities?.supportsVision === true),
      tts: byType("tts"),
      asr: byType("asr"),
      image: byType("image").filter((model) => model.id !== "bria-bg-remover"),
      video: byType("video").filter((model) => model.constraints?.model_type === "text-to-video"),
      music: byType("music"),
    };
  }, [models]);

  const selectedVoiceModel = groups.tts.find((model) => model.id === settings.ttsModel);
  const supportsEmotionalPrompt = selectedVoiceModel?.capabilities?.supportsPromptParam === true || settings.ttsModel.startsWith("tts-qwen3");
  const selectedProfile = VOICE_PROFILES.find((profile) => profile.model === settings.ttsModel && profile.voice === settings.voice);

  const update = <K extends keyof AgentSettings>(key: K, value: AgentSettings[K]) => {
    onChange({ ...settings, [key]: value });
  };

  const updateVoiceModel = (value: string) => {
    const model = groups.tts.find((candidate) => candidate.id === value);
    const nextVoice = model?.defaultVoice ?? model?.voices?.[0] ?? (value === "tts-xai-v1" ? "eve" : settings.voice);
    onChange({ ...settings, ttsModel: value, voice: nextVoice });
  };

  return (
    <>
      <button className={`settings-scrim ${open ? "is-open" : ""}`} onClick={onClose} aria-label="Dismiss settings" tabIndex={open ? 0 : -1} />
      <section className={`settings-modal ${open ? "is-open" : ""}`} role="dialog" aria-modal="true" aria-label="Settings" aria-hidden={!open}>
        <header className="settings-modal-header">
          <div>
            <h2>Settings</h2>
            <p>Control center for how your entity sounds, sees, and thinks.</p>
          </div>
          <button className="icon-button" onClick={onClose} aria-label="Close settings">
            <CloseIcon size={20} />
          </button>
        </header>

        <div className="settings-modal-body">
          <nav className="settings-nav" aria-label="Settings sections">
            {CATEGORIES.map((item) => (
              <button
                key={item.id}
                type="button"
                className={category === item.id ? "is-active" : ""}
                aria-pressed={category === item.id}
                onClick={() => setCategory(item.id)}
              >
                <CategoryIcon id={item.id} />
                <span className="settings-nav-label"><span>{item.label}</span><small>{item.hint}</small></span>
              </button>
            ))}
            <span className="settings-nav-status">
              <i className={connected ? "is-connected" : ""} />
              {connected ? "Venice connected" : "Connecting…"}
            </span>
          </nav>

          <div className="settings-panel">
            {category === "voice" && (
              <section className="settings-group">
                <div className="section-title-row">
                  <div className="settings-group-heading">
                    <h3>Voice</h3>
                    <p>Choose a voice and how expressively it speaks.</p>
                  </div>
                  <button className="preview-button" onClick={onPreviewVoice}>
                    <VolumeIcon size={16} /> Preview
                  </button>
                </div>

                <div className="settings-field">
                  <span className="field-heading"><span>Voice style</span><small>All through Venice</small></span>
                  <div className="voice-profile-grid">
                    {VOICE_PROFILES.map((profile) => (
                      <button
                        type="button"
                        key={profile.id}
                        className={selectedProfile?.id === profile.id ? "is-selected" : ""}
                        onClick={() => onChange({ ...settings, ttsModel: profile.model, voice: profile.voice })}
                        aria-pressed={selectedProfile?.id === profile.id}
                      >
                        <span className="voice-orb" />
                        <span className="voice-copy"><strong>{profile.label}</strong><small>{profile.detail}</small></span>
                      </button>
                    ))}
                  </div>
                  {!selectedProfile && <small className="field-note">A custom voice is selected under Models.</small>}
                </div>

                <label className="settings-field range-field">
                  <span className="field-heading"><span>Speaking speed</span><small>{settings.speed.toFixed(2)}×</small></span>
                  <input type="range" min="0.8" max="1.3" step="0.05" value={settings.speed} onChange={(event) => update("speed", Number(event.target.value))} />
                </label>

                <label className="toggle-field">
                  <span><strong>Adaptive emotion</strong><small>{supportsEmotionalPrompt ? "Directs the model’s delivery for every reply" : "Tunes phrasing and delivery for every reply"}</small></span>
                  <input type="checkbox" checked={settings.emotionalDelivery} onChange={(event) => update("emotionalDelivery", event.target.checked)} />
                  <i />
                </label>
              </section>
            )}

            {category === "behavior" && (
              <section className="settings-group">
                <div className="settings-group-heading">
                  <h3>Camera and behavior</h3>
                  <p>Control what the entity notices and when it acts on its own.</p>
                </div>
                <label className="toggle-field">
                  <span><strong>Camera awareness</strong><small>See motion and expressions while the camera is on</small></span>
                  <input
                    type="checkbox"
                    checked={settings.cameraAwareness}
                    onChange={(event) => onChange({
                      ...settings,
                      cameraAwareness: event.target.checked,
                      talkativeMode: event.target.checked ? settings.talkativeMode : false,
                    })}
                  />
                  <i />
                </label>
                <label className={`toggle-field ${!settings.cameraAwareness ? "is-disabled" : ""}`}>
                  <span><strong>Talkative mode</strong><small>Occasionally starts a conversation about what changes</small></span>
                  <input
                    type="checkbox"
                    checked={settings.talkativeMode}
                    disabled={!settings.cameraAwareness}
                    onChange={(event) => update("talkativeMode", event.target.checked)}
                  />
                  <i />
                </label>
                <label className="toggle-field">
                  <span><strong>Venice web search</strong><small>Let the agent search the live web when useful</small></span>
                  <input type="checkbox" checked={settings.webSearch} onChange={(event) => update("webSearch", event.target.checked)} />
                  <i />
                </label>
                <label className="toggle-field">
                  <span><strong>Filesystem access</strong><small>Let the agent read, create, edit, move, and delete files in your home folder. Risky actions ask first; deletes are recoverable.</small></span>
                  <input type="checkbox" checked={settings.fileAccess} onChange={(event) => update("fileAccess", event.target.checked)} />
                  <i />
                </label>
                <label className={`toggle-field ${!settings.fileAccess ? "is-disabled" : ""}`}>
                  <span><strong>Run terminal commands</strong><small>Let the agent run shell commands (npm, git, builds). It always asks before running.</small></span>
                  <input
                    type="checkbox"
                    checked={settings.shellAccess}
                    disabled={!settings.fileAccess}
                    onChange={(event) => update("shellAccess", event.target.checked)}
                  />
                  <i />
                </label>
              </section>
            )}

            {category === "models" && (
              <section className="settings-group">
                <div className="settings-group-heading">
                  <h3>Models</h3>
                  <p>Pick the Venice models behind each capability.</p>
                </div>
                <div className="settings-model-grid">
                  <ModelSelect
                    label="Voice model"
                    hint={supportsEmotionalPrompt ? "Expressive prompting" : settings.ttsModel === "tts-xai-v1" ? "xAI natural delivery" : "All through Venice"}
                    value={settings.ttsModel}
                    models={groups.tts}
                    onChange={updateVoiceModel}
                  />
                  <ModelSelect label="Conversation" hint="Pi agent" value={settings.chatModel} models={groups.chat} onChange={(value) => update("chatModel", value)} />
                  <ModelSelect label="Camera vision" hint="Expressions and objects" value={settings.visionModel} models={groups.vision} onChange={(value) => update("visionModel", value)} />
                  <ModelSelect label="Transcription" hint="Voice to text" value={settings.sttModel} models={groups.asr} onChange={(value) => update("sttModel", value)} />
                  <ModelSelect label="Images" hint="Creative studio" value={settings.imageModel} models={groups.image} onChange={(value) => update("imageModel", value)} />
                  <ModelSelect label="Video" hint="Creative studio" value={settings.videoModel} models={groups.video} onChange={(value) => update("videoModel", value)} />
                  <ModelSelect label="Music" hint="Creative studio" value={settings.musicModel} models={groups.music} onChange={(value) => update("musicModel", value)} />
                </div>
                <label className="settings-field range-field">
                  <span className="field-heading"><span>Automatic media limit</span><small>${settings.maxMediaUsd.toFixed(2)}</small></span>
                  <input type="range" min="0" max="2" step="0.05" value={settings.maxMediaUsd} onChange={(event) => update("maxMediaUsd", Number(event.target.value))} />
                  <small className="field-note">The agent asks before starting video or music jobs above this price.</small>
                </label>
              </section>
            )}

            {category === "connection" && (
              <section className="settings-group">
                <div className="settings-group-heading">
                  <h3>Connection and privacy</h3>
                  <p>Everything runs locally against your own Venice key.</p>
                </div>
                <div className="privacy-note">
                  <span className={`privacy-status ${connected ? "connected" : ""}`} />
                  <div>
                    <strong>{connected ? "Connected privately" : "Checking Venice"}</strong>
                    <p>Your key stays on this Mac. Short camera clips are sent only while camera awareness is active.</p>
                  </div>
                </div>
              </section>
            )}
          </div>
        </div>
      </section>
    </>
  );
}
