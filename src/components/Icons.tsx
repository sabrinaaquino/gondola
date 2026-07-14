import type { SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement> & { size?: number };

function IconBase({ size = 20, children, ...props }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      {children}
    </svg>
  );
}

export function SettingsIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06-2.83 2.83-.06-.06a1.7 1.7 0 0 0-1.88-.34 1.7 1.7 0 0 0-1.03 1.56V21h-4v-.08A1.7 1.7 0 0 0 8.96 19.4a1.7 1.7 0 0 0-1.88.34l-.06.06-2.83-2.83.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-1.56-1.03H3v-4h.08A1.7 1.7 0 0 0 4.6 8.96a1.7 1.7 0 0 0-.34-1.88L4.2 7.02 7.03 4.2l.06.06a1.7 1.7 0 0 0 1.88.34A1.7 1.7 0 0 0 10 3.04V3h4v.08a1.7 1.7 0 0 0 1.03 1.56 1.7 1.7 0 0 0 1.88-.34l.06-.06 2.83 2.83-.06.06a1.7 1.7 0 0 0-.34 1.88 1.7 1.7 0 0 0 1.56 1.03H21v4h-.08A1.7 1.7 0 0 0 19.4 15Z" />
    </IconBase>
  );
}

export function CameraIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M14.5 5 16 7h3a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2h3l1.5-2h5Z" />
      <circle cx="12" cy="13" r="3.3" />
    </IconBase>
  );
}

export function MicIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d="M5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v3M9 21h6" />
    </IconBase>
  );
}

export function SendIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="m4 4 17 8-17 8 3-8-3-8Z" />
      <path d="M7 12h14" />
    </IconBase>
  );
}

export function PaperclipIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M21.4 11.1 12.3 20.2a5 5 0 0 1-7.1-7.1l9-9a3.3 3.3 0 0 1 4.7 4.7l-9.1 9.1a1.7 1.7 0 0 1-2.4-2.4l8.5-8.5" />
    </IconBase>
  );
}

export function StopIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" stroke="none" />
    </IconBase>
  );
}

export function SparkleIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M12 3c.7 3.8 2.2 5.3 6 6-3.8.7-5.3 2.2-6 6-.7-3.8-2.2-5.3-6-6 3.8-.7 5.3-2.2 6-6Z" />
      <path d="M19 15c.3 1.7 1 2.4 2.7 2.7-1.7.3-2.4 1-2.7 2.7-.3-1.7-1-2.4-2.7-2.7 1.7-.3 2.4-1 2.7-2.7Z" />
    </IconBase>
  );
}

export function VolumeIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M11 5 6 9H3v6h3l5 4V5Z" />
      <path d="M15 9a4 4 0 0 1 0 6M18 6a8 8 0 0 1 0 12" />
    </IconBase>
  );
}

export function CloseIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="m6 6 12 12M18 6 6 18" />
    </IconBase>
  );
}

export function RefreshIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M20 7v5h-5" />
      <path d="M18.5 16a8 8 0 1 1 .7-8.4L20 12" />
    </IconBase>
  );
}

export function ImageIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <circle cx="9" cy="10" r="2" />
      <path d="m4 17 4.5-4 3.5 3 2.5-2 5.5 5" />
    </IconBase>
  );
}

export function PlayIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="m8 5 11 7-11 7V5Z" fill="currentColor" stroke="none" />
    </IconBase>
  );
}

export function EyeIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6Z" />
      <circle cx="12" cy="12" r="2.5" />
    </IconBase>
  );
}

export function PanelLeftIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M9 4v16" />
    </IconBase>
  );
}

export function PlugIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M9 3v5M15 3v5" />
      <path d="M7 8h10v3a5 5 0 0 1-10 0V8Z" />
      <path d="M12 16v5" />
    </IconBase>
  );
}

export function PlusIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M12 5v14M5 12h14" />
    </IconBase>
  );
}

export function ChatIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M4 5.5A1.5 1.5 0 0 1 5.5 4h13A1.5 1.5 0 0 1 20 5.5v9a1.5 1.5 0 0 1-1.5 1.5H10l-4 3.5V16H5.5A1.5 1.5 0 0 1 4 14.5Z" />
    </IconBase>
  );
}

export function MemoryIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M7 3h10a1 1 0 0 1 1 1v16l-6-3.5L6 20V4a1 1 0 0 1 1-1Z" />
    </IconBase>
  );
}

export function AgentIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <rect x="4.5" y="7.5" width="15" height="11.5" rx="3.2" />
      <path d="M12 3.2V7" />
      <circle cx="12" cy="3" r="1.15" fill="currentColor" stroke="none" />
      <circle cx="9.6" cy="13.2" r="1.15" fill="currentColor" stroke="none" />
      <circle cx="14.4" cy="13.2" r="1.15" fill="currentColor" stroke="none" />
    </IconBase>
  );
}

export function ClockIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.5V12l3 2" />
    </IconBase>
  );
}

export function XrayIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <circle cx="12" cy="12" r="8.5" />
      <circle cx="12" cy="12" r="2.2" />
      <path d="M12 3.5V8M12 16v4.5M3.5 12H8M16 12h4.5" />
      <path d="m5.9 5.9 3.2 3.2m5.8 5.8 3.2 3.2m0-12.2-3.2 3.2m-5.8 5.8-3.2 3.2" />
    </IconBase>
  );
}

export function PulseIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M3 12h3.5l2-6.5 4.5 13 2.2-6.5H21" />
    </IconBase>
  );
}

export function TrashIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M4 7h16" />
      <path d="M9 7V5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2" />
      <path d="M6 7v13a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1V7" />
      <path d="M10 11v6M14 11v6" />
    </IconBase>
  );
}

export function FileTextIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M13 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V9l-6-6Z" />
      <path d="M13 3v6h6" />
      <path d="M9 13.5h6M9 16.5h6" />
    </IconBase>
  );
}

export function BoltIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M13.2 2 5 13h6l-.8 9L19 10h-6.1l.3-8Z" />
    </IconBase>
  );
}

export function SearchIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.2-3.2" />
    </IconBase>
  );
}

export function ChevronDownIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="m6 9 6 6 6-6" />
    </IconBase>
  );
}

export function CheckIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="m5 12 4.5 4.5L19 7" />
    </IconBase>
  );
}

export function PencilIcon(props: IconProps) {
  return (
    <IconBase {...props}>
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />
    </IconBase>
  );
}
