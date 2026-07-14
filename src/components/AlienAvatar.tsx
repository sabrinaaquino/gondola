import type { CSSProperties } from "react";
import type { AgentPhase, AvatarAction, MouthViseme, VisualState } from "@/lib/app-types";

interface AlienAvatarProps {
  phase: AgentPhase;
  action: AvatarAction;
  visual?: VisualState;
  audioLevel: number;
  viseme: MouthViseme;
}

interface MouthGeometry {
  path: string;
  filled: boolean;
  teeth: boolean;
  tongue: boolean;
}

function mouthGeometry(phase: AgentPhase, action: AvatarAction, viseme: MouthViseme, visual?: VisualState): MouthGeometry {
  if (phase === "speaking") {
    switch (viseme) {
      case "round":
        return { path: "M90 134 C93 122 107 122 110 134 C112 153 88 153 90 134Z", filled: true, teeth: false, tongue: false };
      case "wide":
        return { path: "M76 139 C86 130 114 130 124 139 C116 154 84 154 76 139Z", filled: true, teeth: true, tongue: false };
      case "open":
        return { path: "M80 137 C87 124 113 124 120 137 C117 159 83 159 80 137Z", filled: true, teeth: true, tongue: true };
      case "small":
        return { path: "M86 139 C91 133 109 133 114 139 C112 151 88 151 86 139Z", filled: true, teeth: false, tongue: false };
      default:
        return { path: "M84 143 C92 140 108 140 116 143 C108 148 92 148 84 143Z", filled: true, teeth: false, tongue: false };
    }
  }
  const smile = visual?.expression.smile ?? 0;
  const open = visual?.expression.mouth_open ?? 0;
  if (action === "surprised" || open > 0.68) return { path: "M89 136 C89 121 111 121 111 136 C111 154 89 154 89 136Z", filled: true, teeth: false, tongue: false };
  if (action === "frown") return { path: "M78 148 C88 137 112 137 122 148 C112 143 88 143 78 148Z", filled: false, teeth: false, tongue: false };
  if (["smile", "laugh"].includes(action) || smile > 0.55) return { path: "M74 132 C86 151 114 151 126 132 C121 161 79 161 74 132Z", filled: true, teeth: true, tongue: action === "laugh" };
  return { path: "M82 143 C91 148 109 148 118 143 C109 150 91 150 82 143Z", filled: false, teeth: false, tongue: false };
}

export function AlienAvatar({ phase, action, visual, audioLevel, viseme }: AlienAvatarProps) {
  const headX = action === "look_left" || visual?.head.direction === "left" ? -7 : action === "look_right" || visual?.head.direction === "right" ? 7 : 0;
  const tilt = action === "tilt" || visual?.head.tilt === "left" ? -5 : visual?.head.tilt === "right" ? 5 : 0;
  const style = {
    "--audio": Math.max(0.05, audioLevel).toFixed(3),
    "--head-x": `${headX}px`,
    "--head-tilt": `${tilt}deg`,
  } as CSSProperties;
  const eyesClosed = (visual?.expression.eyes_closed ?? 0) > 0.68;
  const mouth = mouthGeometry(phase, action, viseme, visual);

  return (
    <div className={`alien-orbit phase-${phase} action-${action}`} style={style} aria-label={`Entity is ${phase}`}>
      <div className="halo-glow" />
      <div className="halo-ring halo-ring-one" />
      <div className="halo-ring halo-ring-two" />
      <div className="halo-ring halo-ring-three" />
      <div className="halo-dust" aria-hidden="true">
        {Array.from({ length: 14 }, (_, index) => <i key={index} />)}
      </div>
      <div className="alien-float">
        <svg className="alien-svg" viewBox="0 0 200 205" role="img" aria-label="Expressive green alien avatar">
          <defs>
            <radialGradient id="faceGradient" cx="38%" cy="26%" r="72%">
              <stop offset="0%" stopColor="#d8ff8a" />
              <stop offset="36%" stopColor="#95ee57" />
              <stop offset="72%" stopColor="#4ebd69" />
              <stop offset="100%" stopColor="#238161" />
            </radialGradient>
            <linearGradient id="earGradient" x1="0" x2="1" y1="0" y2="1">
              <stop stopColor="#8fe95b" />
              <stop offset="1" stopColor="#277d60" />
            </linearGradient>
            <radialGradient id="eyeGradient" cx="36%" cy="28%" r="72%">
              <stop stopColor="#fff" />
              <stop offset="0.18" stopColor="#b7fff1" />
              <stop offset="0.48" stopColor="#20cfd0" />
              <stop offset="0.75" stopColor="#17374b" />
              <stop offset="1" stopColor="#071019" />
            </radialGradient>
            <filter id="faceShadow" x="-30%" y="-30%" width="160%" height="180%">
              <feDropShadow dx="0" dy="10" stdDeviation="11" floodColor="#071613" floodOpacity=".55" />
            </filter>
            <filter id="eyeGlow" x="-60%" y="-60%" width="220%" height="220%">
              <feGaussianBlur stdDeviation="2" result="blur" />
              <feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge>
            </filter>
          </defs>

          <g className="alien-head" filter="url(#faceShadow)">
            <path className="alien-ear ear-left" d="M45 80 C14 48 4 60 18 100 C24 118 36 122 52 112Z" fill="url(#earGradient)" />
            <path className="alien-ear ear-right" d="M155 80 C186 48 196 60 182 100 C176 118 164 122 148 112Z" fill="url(#earGradient)" />
            <path className="ear-inner ear-left" d="M37 85 C20 69 16 75 24 99 C28 108 35 111 44 106Z" fill="#b9ff79" opacity=".42" />
            <path className="ear-inner ear-right" d="M163 85 C180 69 184 75 176 99 C172 108 165 111 156 106Z" fill="#b9ff79" opacity=".42" />
            <path
              d="M100 17 C57 17 36 45 39 91 C41 125 56 170 100 181 C144 170 159 125 161 91 C164 45 143 17 100 17Z"
              fill="url(#faceGradient)"
              stroke="#b8ff7d"
              strokeOpacity=".24"
              strokeWidth="1.5"
            />
            <path d="M65 39 C83 24 111 21 132 31" fill="none" stroke="#efffc7" strokeWidth="7" strokeLinecap="round" opacity=".18" />
            <ellipse cx="100" cy="174" rx="24" ry="5" fill="#173d36" opacity=".22" />

            <g className={`alien-eyes ${eyesClosed ? "eyes-closed" : ""}`} filter="url(#eyeGlow)">
              <ellipse className="eye eye-left" cx="72" cy="98" rx="21" ry="29" fill="url(#eyeGradient)" transform="rotate(-12 72 98)" />
              <ellipse className="eye eye-right" cx="128" cy="98" rx="21" ry="29" fill="url(#eyeGradient)" transform="rotate(12 128 98)" />
              <ellipse className="eye-shine eye-left" cx="65" cy="88" rx="5" ry="8" fill="white" opacity=".88" />
              <ellipse className="eye-shine eye-right" cx="121" cy="88" rx="5" ry="8" fill="white" opacity=".88" />
            </g>

            <path className="alien-brow brow-left" d="M51 69 Q72 57 89 72" fill="none" stroke="#276c53" strokeWidth="4" strokeLinecap="round" opacity=".55" />
            <path className="alien-brow brow-right" d="M111 72 Q128 57 149 69" fill="none" stroke="#276c53" strokeWidth="4" strokeLinecap="round" opacity=".55" />
            <path className="alien-nose" d="M96 124 Q100 129 104 124" fill="none" stroke="#247354" strokeWidth="2.5" strokeLinecap="round" opacity=".6" />
            <g className={`alien-mouth-group viseme-${viseme}`}>
              <path className="alien-mouth" d={mouth.path} fill={mouth.filled ? "#12352f" : "none"} stroke="#173f36" strokeWidth="4.5" strokeLinecap="round" strokeLinejoin="round" />
              {mouth.teeth && (
                <path className="alien-teeth" d="M82 138 C91 133 109 133 118 138 C109 142 91 142 82 138Z" fill="#efffdc" opacity=".9" />
              )}
              {mouth.tongue && (
                <path className="alien-tongue" d="M88 151 C94 146 106 146 112 151 C106 157 94 157 88 151Z" fill="#71b985" opacity=".68" />
              )}
            </g>
          </g>
        </svg>
      </div>
      <div className="phase-caption" aria-live="polite">
        <span className="phase-dot" />
        {phase === "idle" ? "Ready" : phase === "tool" ? "Creating with Venice" : `${phase.charAt(0).toUpperCase()}${phase.slice(1)}`}
      </div>
    </div>
  );
}
