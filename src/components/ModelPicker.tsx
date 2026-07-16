import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import type { CatalogModel, ReasoningEffort } from "@/lib/app-types";
import { findFastModelPair, isFastModel, supportedReasoningEfforts } from "@/lib/model-capabilities";
import { BoltIcon, CheckIcon, ChevronDownIcon, SearchIcon } from "./Icons";

interface ModelPickerProps {
  models: CatalogModel[];
  value: string;
  onChange: (id: string) => void;
  disabled?: boolean;
  variant?: "header" | "composer";
  reasoningEffort?: ReasoningEffort;
  onReasoningEffortChange?: (effort: ReasoningEffort) => void;
}

interface OptionBadge {
  label: string;
  className?: string;
  title?: string;
}

// Recognized model families in the order we want them surfaced. Anything that
// matches none of these (niche/experimental models) sinks below the mainstream
// picks so the list never opens on an obscure model.
const FAMILY_ORDER = [
  "claude", "gpt", "openai", "llama", "qwen", "deepseek", "glm", "zai",
  "mistral", "mixtral", "gemini", "grok", "venice", "kimi", "gemma", "command", "nemotron",
];

function familyRank(model: CatalogModel): number {
  const haystack = `${model.name} ${model.id}`.toLowerCase();
  const index = FAMILY_ORDER.findIndex((key) => haystack.includes(key));
  return index === -1 ? FAMILY_ORDER.length : index;
}

function contextLabel(model: CatalogModel): string | undefined {
  const tokens = model.capabilities?.availableContextTokens;
  if (typeof tokens !== "number" || tokens <= 0) return undefined;
  return tokens >= 1000 ? `${Math.round(tokens / 1000)}K` : `${tokens}`;
}

function badgesFor(model: CatalogModel): OptionBadge[] {
  const badges: OptionBadge[] = [];
  if (isFastModel(model)) badges.push({ label: "Fast", className: "tag-fast" });
  if (model.beta) badges.push({ label: "Beta", className: "tag-beta" });
  if (model.privacy === "private") badges.push({ label: "Private", className: "tag-private" });
  return badges.slice(0, 2);
}

// The conversation runs through the Pi agent, which needs tool calling, so only
// text models that advertise function calling are valid choices here.
function isChatModel(model: CatalogModel): boolean {
  return model.type === "text" && model.capabilities?.supportsFunctionCalling === true;
}

const EFFORT_LABELS: Record<ReasoningEffort, string> = {
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Maximum",
};

export function ModelPicker({
  models,
  value,
  onChange,
  disabled,
  variant = "header",
  reasoningEffort = "medium",
  onReasoningEffortChange,
}: ModelPickerProps) {
  const [open, setOpen] = useState(false);
  const [effortOpen, setEffortOpen] = useState(false);
  const [query, setQuery] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const chatModels = useMemo(
    () => models
      .filter(isChatModel)
      .sort((a, b) => (familyRank(a) - familyRank(b)) || a.name.localeCompare(b.name)),
    [models],
  );

  // A paired Fast variant is presented as a mode on its base model, not as a
  // duplicate item in a catalog that is already long.
  const pickerModels = useMemo(
    () => chatModels.filter((model) => !isFastModel(model) || !findFastModelPair(chatModels, model)),
    [chatModels],
  );

  const current = useMemo(() => models.find((model) => model.id === value), [models, value]);
  const currentName = current?.name ?? value ?? "Select model";
  const currentIsChat = Boolean(current && isChatModel(current));
  const fastPair = useMemo(() => findFastModelPair(chatModels, current), [chatModels, current]);
  const fastActive = isFastModel(current);
  const displayName = fastPair?.base.name ?? currentName;
  const reasoningOptions = useMemo(() => supportedReasoningEfforts(current), [current]);
  const effectiveEffort = reasoningOptions.includes(reasoningEffort)
    ? reasoningEffort
    : reasoningOptions.includes("medium") ? "medium" : reasoningOptions[0];

  const rest = useMemo(() => pickerModels.filter((model) => (
    model.id !== value
    && !(fastActive && fastPair && model.id === fastPair.base.id)
  )), [fastActive, fastPair, pickerModels, value]);

  // When searching we show a single flat, ranked list; otherwise the current
  // model is pinned at the top followed by the rest in mainstream-first order.
  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return null;
    return pickerModels.filter((model) => `${model.name} ${model.id}`.toLowerCase().includes(needle));
  }, [pickerModels, query]);

  useEffect(() => {
    if (!open && !effortOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpen(false);
        setEffortOpen(false);
      }
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
        setEffortOpen(false);
      }
    };
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKey);
    const focusTimer = open ? window.setTimeout(() => searchRef.current?.focus(), 30) : undefined;
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKey);
      if (focusTimer) window.clearTimeout(focusTimer);
    };
  }, [effortOpen, open]);

  // Swap the active model, keeping the reasoning effort valid for the new choice.
  const applyModel = (id: string) => {
    const next = models.find((model) => model.id === id);
    const nextEfforts = supportedReasoningEfforts(next);
    if (nextEfforts.length && !nextEfforts.includes(reasoningEffort)) {
      onReasoningEffortChange?.(nextEfforts.includes("medium") ? "medium" : nextEfforts[0]);
    }
    onChange(id);
  };

  const select = (id: string) => {
    applyModel(id);
    setOpen(false);
    setEffortOpen(false);
    setQuery("");
  };

  // Toggle Fast mode without closing the dropdown (used by the dropdown switch).
  const toggleFast = () => {
    if (fastPair) applyModel(fastActive ? fastPair.base.id : fastPair.fast.id);
  };

  const renderRow = (model: CatalogModel) => {
    const active = model.id === value;
    const context = contextLabel(model);
    const modelFastPair = findFastModelPair(chatModels, model);
    const rowName = modelFastPair && isFastModel(model) ? modelFastPair.base.name : model.name;
    const fastAvailable = Boolean(modelFastPair && !isFastModel(model));
    return (
      <button
        type="button"
        key={model.id}
        role="option"
        aria-selected={active}
        className={`model-picker-option ${active ? "is-active" : ""}`}
        onClick={() => select(model.id)}
      >
        <span className="model-picker-option-name">{rowName}</span>
        <span className="model-picker-option-tags">
          {fastAvailable && <em className="tag-fast" title="Fast mode available">Fast</em>}
          {badgesFor(model).map((badge) => (
            <em key={badge.label} className={badge.className} title={badge.title} aria-label={badge.title}>{badge.label}</em>
          ))}
          {context && <em className="tag-ctx">{context}</em>}
          {active && <CheckIcon size={13} />}
        </span>
      </button>
    );
  };

  return (
    <div className={`model-picker ${variant === "composer" ? "is-composer" : ""}`} ref={rootRef}>
      {variant === "composer" ? (
        <div className="composer-model-pill">
          <button
            type="button"
            className="composer-model-main"
            onClick={() => { setEffortOpen(false); setOpen((previous) => !previous); }}
            disabled={disabled}
            aria-haspopup="listbox"
            aria-expanded={open}
            title={`Conversation model: ${currentName}`}
          >
            <span className="composer-model-glyph" aria-hidden="true">◈</span>
            <span>{displayName}</span>
          </button>
          {reasoningOptions.length > 0 && effectiveEffort && (
            <button
              type="button"
              className={`composer-model-effort ${effortOpen ? "is-open" : ""}`}
              onClick={() => { setOpen(false); setEffortOpen((previous) => !previous); }}
              disabled={disabled}
              aria-haspopup="dialog"
              aria-expanded={effortOpen}
              title="Choose reasoning effort"
            >
              {EFFORT_LABELS[effectiveEffort]}
            </button>
          )}
          {fastPair && fastActive && (
            <button
              type="button"
              className="composer-model-fast is-active"
              onClick={toggleFast}
              disabled={disabled}
              aria-pressed={true}
              title="Fast mode on — click to turn off"
            >
              <BoltIcon size={12} /><span>Fast</span>
            </button>
          )}
          <button
            type="button"
            className="composer-model-chevron"
            onClick={() => { setEffortOpen(false); setOpen((previous) => !previous); }}
            disabled={disabled}
            aria-label="Choose conversation model"
            aria-expanded={open}
          >
            <ChevronDownIcon size={13} />
          </button>
        </div>
      ) : (
        <button
          type="button"
          className={`model-picker-trigger ${open ? "is-open" : ""}`}
          onClick={() => setOpen((previous) => !previous)}
          disabled={disabled}
          aria-haspopup="listbox"
          aria-expanded={open}
          title={`Conversation model: ${currentName}`}
        >
          <span className="model-picker-glyph" aria-hidden="true">◈</span>
          <span className="model-picker-name">{currentName}</span>
          <ChevronDownIcon size={13} />
        </button>
      )}

      {open && (
        <div className="model-picker-pop" role="dialog" aria-label="Choose conversation model">
          <div className="model-picker-search">
            <SearchIcon size={14} />
            <input
              ref={searchRef}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={`Search ${pickerModels.length} models…`}
              spellCheck={false}
              autoComplete="off"
              aria-label="Search conversation models"
            />
            {query && (
              <button type="button" className="model-picker-clear" onClick={() => setQuery("")} aria-label="Clear search">×</button>
            )}
          </div>

          {fastPair && (
            <button
              type="button"
              role="switch"
              aria-checked={fastActive}
              className={`model-picker-fast ${fastActive ? "is-active" : ""}`}
              onClick={toggleFast}
              disabled={disabled}
            >
              <BoltIcon size={14} />
              <span className="model-picker-fast-text">
                <strong>Fast mode</strong>
                <small>Lower latency, same model</small>
              </span>
              <span className="model-picker-fast-switch" aria-hidden="true"><i /></span>
            </button>
          )}

          <div className="model-picker-list" role="listbox">
            {filtered ? (
              filtered.length ? (
                filtered.map(renderRow)
              ) : (
                <p className="model-picker-empty">No models match “{query.trim()}”.</p>
              )
            ) : (
              <>
                {currentIsChat && current && (
                  <>
                    <p className="model-picker-group-label">Selected</p>
                    {renderRow(current)}
                  </>
                )}
                <p className="model-picker-group-label">Models</p>
                {rest.map(renderRow)}
              </>
            )}
          </div>
        </div>
      )}

      {effortOpen && reasoningOptions.length > 0 && effectiveEffort && (
        <div className="model-effort-pop" role="dialog" aria-label="Reasoning effort">
          <div className="model-effort-head">
            <div><span>Reasoning effort</span><strong>{EFFORT_LABELS[effectiveEffort]}</strong></div>
            <small>Higher effort gives the model more time to think.</small>
          </div>
          <div
            className="model-effort-track"
            role="radiogroup"
            aria-label="Reasoning effort"
            style={{ "--effort-progress": `${(reasoningOptions.indexOf(effectiveEffort) / Math.max(1, reasoningOptions.length - 1)) * 100}%` } as CSSProperties}
          >
            {reasoningOptions.map((effort) => (
              <button
                type="button"
                role="radio"
                aria-checked={effort === effectiveEffort}
                className={effort === effectiveEffort ? "is-active" : ""}
                key={effort}
                onClick={() => { onReasoningEffortChange?.(effort); setEffortOpen(false); }}
              >
                <i /><span>{EFFORT_LABELS[effort]}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
