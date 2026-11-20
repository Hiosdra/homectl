// Inline SVG icons for the owner panel. The CSP forbids external icon files and
// fonts, so every icon is drawn here. Icons are decorative (aria-hidden): the words
// beside them carry the meaning.
export type IconName =
  | "inbox"
  | "bot"
  | "shield"
  | "devices"
  | "sliders"
  | "check"
  | "check-circle"
  | "x"
  | "alert"
  | "info"
  | "clock"
  | "key"
  | "lock"
  | "chevron"
  | "back"
  | "refresh"
  | "logout"
  | "eye"
  | "pencil"
  | "trash"
  | "bell"
  | "signal";

function circle(cx: number, cy: number, r: number): string {
  return `M${cx - r} ${cy}a${r} ${r} 0 1 0 ${2 * r} 0a${r} ${r} 0 1 0 ${-2 * r} 0`;
}

const PATHS: Record<IconName, string[]> = {
  inbox: [
    "M3 13h5l1.5 3h5l1.5-3h5",
    "M5.5 5.5 3 13v6a1 1 0 0 0 1 1h16a1 1 0 0 0 1-1v-6l-2.5-7.5A1 1 0 0 0 17.5 5h-11a1 1 0 0 0-1 .5z",
  ],
  bot: [
    "M5 9h14a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2z",
    "M12 9V5",
    circle(12, 4, 1),
    "M8.5 14h.01M15.5 14h.01",
    "M9 18h6",
  ],
  shield: [
    "M12 3 4.5 6v5.5c0 4.5 3.2 8.2 7.5 9.5 4.3-1.3 7.5-5 7.5-9.5V6z",
    "M9 12l2.2 2.2L15.5 10",
  ],
  devices: ["M3 5h12v9H3z", "M7 18h4", "M15 9h5v10h-5z"],
  sliders: ["M4 7h9M17 7h3M4 17h3M11 17h9", circle(15, 7, 2), circle(9, 17, 2)],
  check: ["M5 12.5l4.5 4.5L19 7.5"],
  "check-circle": [circle(12, 12, 9), "M8 12.5l2.7 2.7L16 9.5"],
  x: ["M6 6l12 12M18 6 6 18"],
  alert: [
    "M10.3 4.2 2.6 17.5A2 2 0 0 0 4.3 20.5h15.4a2 2 0 0 0 1.7-3L13.7 4.2a2 2 0 0 0-3.4 0z",
    "M12 10v4",
    "M12 17.2v.1",
  ],
  info: [circle(12, 12, 9), "M12 11v5", "M12 7.8v.1"],
  clock: [circle(12, 12, 9), "M12 7v5l3 2"],
  key: [circle(8, 15, 4), "M11 12l9-9M17 6l3 3"],
  lock: ["M6 11h12v9H6z", "M8.5 11V8a3.5 3.5 0 0 1 7 0v3"],
  chevron: ["M9 6l6 6-6 6"],
  back: ["M19 12H5", "M11 6l-6 6 6 6"],
  refresh: ["M20 11a8 8 0 1 0 1.5 4.6", "M20 4v7h-7"],
  logout: ["M10 4H5v16h5", "M15 8l4 4-4 4", "M19 12H9"],
  eye: [
    "M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z",
    circle(12, 12, 3),
  ],
  pencil: ["M4 20h4L19 9l-4-4L4 16z", "M13.5 6.5l4 4"],
  trash: ["M4 7h16", "M9 7V4.5h6V7", "M6.5 7l1 13h9l1-13"],
  bell: ["M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15z", "M10 20.5a2 2 0 0 0 4 0"],
  signal: ["M4 19v-3", "M9 19v-7", "M14 19V8", "M19 19V4"],
};

export function Icon({ name }: { name: IconName }) {
  return (
    <svg
      className="icon"
      viewBox="0 0 24 24"
      aria-hidden="true"
      focusable="false"
    >
      {PATHS[name].map((d) => (
        <path key={d} d={d} />
      ))}
    </svg>
  );
}
