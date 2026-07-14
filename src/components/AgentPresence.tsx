import type { CSSProperties } from "react";
import type { AgentPhase, AvatarAction, MouthViseme, PresenceDirective, VisualState } from "@/lib/app-types";

interface AgentPresenceProps {
  name: string;
  phase: AgentPhase;
  action: AvatarAction;
  visual?: VisualState;
  audioLevel: number;
  directive: PresenceDirective;
  viseme?: MouthViseme;
}

interface MoodState {
  label: string;
  energy: number;
  hue: number;
}

function moodFor(phase: AgentPhase, action: AvatarAction, visual?: VisualState): MoodState {
  if (phase === "error") return { label: "needs attention", energy: 36, hue: 8 };
  if (phase === "listening") return { label: "attentive", energy: 64, hue: 208 };
  if (phase === "transcribing") return { label: "making sense", energy: 58, hue: 218 };
  if (phase === "thinking") return { label: "curious", energy: 72, hue: 262 };
  if (phase === "tool") return { label: "creating", energy: 86, hue: 42 };
  if (phase === "speaking") return { label: "expressive", energy: 70, hue: 202 };
  if (action === "laugh") return { label: "delighted", energy: 92, hue: 38 };
  if (action === "smile" || (visual?.expression.smile ?? 0) > 0.58) return { label: "warm", energy: 62, hue: 42 };
  if (action === "surprised") return { label: "surprised", energy: 94, hue: 38 };
  if (action === "frown") return { label: "concerned", energy: 34, hue: 214 };
  if (["look_left", "look_right", "tilt"].includes(action)) return { label: "curious", energy: 56, hue: 188 };
  if (["bounce", "nod", "wink"].includes(action)) return { label: "playful", energy: 82, hue: 226 };
  return { label: "calm", energy: 24, hue: 210 };
}

const paletteHue: Record<PresenceDirective["palette"], number> = {
  porcelain: 42,
  ice: 208,
  violet: 266,
  amber: 34,
  rose: 346,
  aqua: 184,
};

export function AgentPresence({ name, phase, action, visual, audioLevel, directive, viseme = "rest" }: AgentPresenceProps) {
  const mood = moodFor(phase, action, visual);
  const style = {
    "--audio": Math.max(0.05, audioLevel).toFixed(3),
    "--presence-hue": String(phase === "idle" ? paletteHue[directive.palette] : mood.hue),
    "--presence-energy": Math.max(mood.energy / 100, directive.intensity).toFixed(2),
    "--presence-intensity": Math.max(0.1, Math.min(1, directive.intensity)).toFixed(2),
  } as CSSProperties;

  return (
    <div className={`alien-orbit presence-orbit phase-${phase} action-${action} form-${directive.form} motion-${directive.motion} direction-${directive.direction} viseme-${viseme}`} style={style} aria-label={`${name} feels ${mood.label}`}>
      <div className="halo-glow" />
      <div className="halo-ring halo-ring-one" />
      <div className="halo-ring halo-ring-two" />
      <div className="halo-ring halo-ring-three" />
      <div className="halo-dust" aria-hidden="true">
        {Array.from({ length: 14 }, (_, index) => <i key={index} />)}
      </div>

      <div className="presence-shell" aria-hidden="true">
        <div className="presence-membrane" />
        <div className="presence-wave presence-wave-one" />
        <div className="presence-wave presence-wave-two" />
        <div className="presence-glint" />
      </div>
    </div>
  );
}
