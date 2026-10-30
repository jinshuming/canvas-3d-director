/** Line icons in the 24-unit, 2px-stroke style TapNow uses (lucide-style paths). */

const PATHS = {
  plus: <path d="M12 5v14M5 12h14" />,
  x: <path d="M18 6 6 18M6 6l12 12" />,
  search: <><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></>,
  chevronDown: <path d="m6 9 6 6 6-6" />,
  chevronLeft: <path d="m15 18-6-6 6-6" />,
  chevronRight: <path d="m9 18 6-6-6-6" />,
  scene: <><rect x="3" y="4" width="18" height="16" rx="3" /><path d="m3 16 5-5 4 4 3-3 6 6" /><circle cx="15.5" cy="8.5" r="1.5" /></>,
  character: <><rect x="3" y="3" width="18" height="18" rx="4" /><circle cx="12" cy="10" r="3" /><path d="M7 19c.8-2.5 2.7-4 5-4s4.2 1.5 5 4" /></>,
  motion: <path d="M3 12h3l3-7 4 14 3-7h5" />,
  camera: <><path d="M15 10l5-3v10l-5-3z" /><rect x="3" y="6" width="12" height="12" rx="2.5" /></>,
  film: <><rect x="3" y="3" width="18" height="18" rx="2.5" /><path d="M7 3v18M17 3v18M3 8h4M3 16h4M17 8h4M17 16h4M3 12h18" /></>,
  undo: <><path d="M9 14 4 9l5-5" /><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11" /></>,
  redo: <><path d="m15 14 5-5-5-5" /><path d="M20 9H9.5a5.5 5.5 0 0 0 0 11H13" /></>,
  play: <path d="M7 4.5v15l12-7.5z" fill="currentColor" stroke="none" />,
  pause: <><rect x="6" y="4.5" width="4" height="15" rx="1" fill="currentColor" stroke="none" /><rect x="14" y="4.5" width="4" height="15" rx="1" fill="currentColor" stroke="none" /></>,
  download: <><path d="M12 3v12M7 10l5 5 5-5" /><path d="M5 21h14" /></>,
  image: <><rect x="3" y="3" width="18" height="18" rx="3" /><circle cx="9" cy="9" r="2" /><path d="m21 15-4-4L6 21" /></>,
  video: <><rect x="3" y="3" width="18" height="18" rx="3" /><path d="m10 8.5 5 3.5-5 3.5z" /></>,
  sparkle: <path d="M12 3v4M12 17v4M3 12h4M17 12h4M6.3 6.3l2.4 2.4M15.3 15.3l2.4 2.4M6.3 17.7l2.4-2.4M15.3 8.7l2.4-2.4" />,
  key: <path d="M12 3 21 12 12 21 3 12z" />,
  move: <path d="M12 3v18M3 12h18M12 3l-3 3M12 3l3 3M12 21l-3-3M12 21l3-3M3 12l3-3M3 12l3 3M21 12l-3-3M21 12l-3 3" />,
  focus: <><path d="M4 9V5a1 1 0 0 1 1-1h4M15 4h4a1 1 0 0 1 1 1v4M20 15v4a1 1 0 0 1-1 1h-4M9 20H5a1 1 0 0 1-1-1v-4" /><circle cx="12" cy="12" r="2.5" /></>,
  trash: <path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3" />,
  settings: <><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" /></>,
  upload: <><path d="M12 15V3M7 8l5-5 5 5" /><path d="M5 21h14" /></>,
  folder: <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />,
  plug: <><path d="M9 2v5M15 2v5" /><path d="M6 7h12v4a6 6 0 0 1-12 0z" /><path d="M12 17v5" /></>,
  credits: <><circle cx="12" cy="12" r="9" /><path d="M8 8.5c2.5-1.5 5.5-1.5 8 0M7.5 12h9M8 15.5c2.5 1.5 5.5 1.5 8 0M12 3c-2.5 3-2.5 15 0 18M12 3c2.5 3 2.5 15 0 18" /></>,
  users: <><circle cx="12" cy="8" r="2.5" /><circle cx="5.5" cy="10" r="2" /><circle cx="18.5" cy="10" r="2" /><path d="M7.5 19c.6-2.8 2.3-4.5 4.5-4.5s3.9 1.7 4.5 4.5M2.5 18c.3-1.8 1.4-3 3-3.3M21.5 18c-.3-1.8-1.4-3-3-3.3" /></>,
  share: <><circle cx="18" cy="5.5" r="2.5" /><circle cx="6" cy="12" r="2.5" /><circle cx="18" cy="18.5" r="2.5" /><path d="m8.2 10.8 7.6-4M8.2 13.2l7.6 4" /></>,
  copy: <><rect x="8" y="8" width="13" height="12" rx="2.5" /><path d="M16 8V6a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3" /></>,
  layout: <><rect x="4" y="3" width="16" height="6" rx="1.5" /><path d="M4 13h7M4 17h7M4 21h7M15 13h5v8h-5z" /></>,
  chat: <path d="M21 12a8.5 8.5 0 0 1-12.6 7.4L3 21l1.6-5.1A8.5 8.5 0 1 1 21 12z" />,
  history: <><path d="M3 12a9 9 0 1 0 3-6.7L3 8" /><path d="M3 3v5h5M12 7v5l3 2" /></>,
  cursorBox: <><rect x="3" y="4" width="15" height="12" rx="2" /><path d="M13 13l8 3-3.5 1.2L16 21z" /></>,
  curve: <><circle cx="5" cy="19" r="2" /><circle cx="19" cy="5" r="2" /><path d="M6.5 17.5C9 9 12 14 17.5 6.5" /></>,
  magnet: <><path d="M5 4h4v8a3 3 0 0 0 6 0V4h4v8a7 7 0 0 1-14 0z" /><path d="M5 8h4M15 8h4" /></>,
  fullscreen: <path d="M4 9V5a1 1 0 0 1 1-1h4M15 4h4a1 1 0 0 1 1 1v4M20 15v4a1 1 0 0 1-1 1h-4M9 20H5a1 1 0 0 1-1-1v-4" />,
  help: <><circle cx="12" cy="12" r="9" /><path d="M9.5 9.5a2.5 2.5 0 0 1 4.9.7c0 1.8-2.4 2.2-2.4 3.8M12 17h.01" /></>,
  edit: <><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" /></>,
  expand: <path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7" />,
  more: <><circle cx="5" cy="12" r="1.3" fill="currentColor" /><circle cx="12" cy="12" r="1.3" fill="currentColor" /><circle cx="19" cy="12" r="1.3" fill="currentColor" /></>,
  mic: <><rect x="9" y="3" width="6" height="11" rx="3" /><path d="M5 11a7 7 0 0 0 14 0M12 18v3" /></>,
  hand: <path d="M8 13V5.5a1.5 1.5 0 0 1 3 0V12M11 11V4a1.5 1.5 0 0 1 3 0v7M14 11V5.5a1.5 1.5 0 0 1 3 0V13M17 9.5a1.5 1.5 0 0 1 3 0V15a6 6 0 0 1-6 6h-1.5a6 6 0 0 1-4.6-2.2L5 15.5a1.5 1.5 0 0 1 2.3-2L8 14.5" />,
  bulb: <><path d="M9 18h6M10 21h4" /><path d="M12 3a6 6 0 0 0-3.5 10.9c.7.5 1 1.3 1 2.1h5c0-.8.3-1.6 1-2.1A6 6 0 0 0 12 3z" /></>,
  arrowRight: <path d="M5 12h14M13 6l6 6-6 6" />,
  arrowUp: <path d="M12 19V5M6 11l6-6 6 6" />,
  globe: <><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3c2.5 2.6 3.8 5.6 3.8 9s-1.3 6.4-3.8 9c-2.5-2.6-3.8-5.6-3.8-9S9.5 5.6 12 3z" /></>,
  box: <><path d="M12 3 20 7.5v9L12 21l-8-4.5v-9z" /><path d="M4 7.5 12 12l8-4.5M12 12v9" /></>,
  text: <path d="M4 6h16M4 12h12M4 18h16" />,
  audio: <path d="M4 10v4M8 7v10M12 4v16M16 8v8M20 11v2" />,
  previs: <><path d="M3 9a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2h-4l-3-3-3 3H5a2 2 0 0 1-2-2z" /><circle cx="8" cy="11.5" r="1.3" /><circle cx="16" cy="11.5" r="1.3" /></>,
  imageEdit: <><rect x="3" y="3" width="18" height="18" rx="3" /><circle cx="8.5" cy="8.5" r="1.8" /><path d="m21 15-5-5-4 4M14 20l6-6" /></>,
  swap: <path d="M17 3l4 4-4 4M3 7h18M7 21l-4-4 4-4M21 17H3" />,
  loop: <><path d="M17 2l4 4-4 4" /><path d="M3 11v-1a4 4 0 0 1 4-4h14M7 22l-4-4 4-4" /><path d="M21 13v1a4 4 0 0 1-4 4H3" /></>,
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({ name, size = 18, className }: { name: IconName; size?: number; className?: string }) {
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {PATHS[name]}
    </svg>
  );
}

/** The four-colour orb in the top-left pill. */
export function Logo({ size = 26 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
      <defs>
        <radialGradient id="lg-a" cx="30%" cy="30%" r="70%"><stop offset="0" stopColor="#ffd0e6" /><stop offset="1" stopColor="#ff6fae" /></radialGradient>
        <radialGradient id="lg-b" cx="70%" cy="30%" r="70%"><stop offset="0" stopColor="#d6f0ff" /><stop offset="1" stopColor="#4f9dff" /></radialGradient>
        <radialGradient id="lg-c" cx="50%" cy="80%" r="70%"><stop offset="0" stopColor="#fff2b8" /><stop offset="1" stopColor="#ffb547" /></radialGradient>
      </defs>
      <circle cx="12" cy="13" r="9" fill="url(#lg-a)" opacity="0.95" />
      <circle cx="20" cy="13" r="9" fill="url(#lg-b)" opacity="0.85" />
      <circle cx="16" cy="20" r="9" fill="url(#lg-c)" opacity="0.8" />
    </svg>
  );
}
