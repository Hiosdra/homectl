// Design system of the owner panel. Read this block before changing a screen.
//
// Design notes (Phase 1, 0.3 owner panel redesign)
//
// Audience: a homelab owner who is not a sysadmin. Each screen answers one
// question and offers one primary action. Plain words first; technical values
// (host ids, rule ids, revisions, risk codes) sit behind "Details" or "Why?".
//
// Information architecture (nav order, phone tab bar and desktop sidebar alike):
//   1. Needs you       what waits for the owner: approvals, secret requests,
//                      linked-client approvals. Approve or deny in one tap for
//                      small, undoable changes; the exact command is always shown.
//   2. Assistants      AI tools that ask homectl for work: add, rotate, revoke.
//   3. Permissions     who may do what, when homectl asks, saved rules, the AI helper.
//   4. Devices & backup linked devices (workspace server only): invite, clients,
//                      decisions and restores.
//   5. System          updates for this homectl and browser notifications.
//   Detail screens (approval, secret request) open from Needs you, never from the nav.
//
// States (every screen):
//   - Empty: says why it is empty and what happens next ("Agents keep working
//     within their permissions; this page updates live.").
//   - First run: the sign-in screen names what the owner is protecting and how long
//     the session lasts.
//   - Success: a toast names the result and where it was recorded, then clears.
//   - Error: says what happened and what to do next, never a bare code.
//   - Time: relative first ("in 12 minutes", "2 hours ago"), absolute in a title.
//
// Visual system:
//   - Colour is tokens on :root, with a light theme and a dark theme (prefers-color-
//     scheme, plus data-theme overrides). Text pairs meet WCAG AA (4.5:1); the
//     unit test tests/owner-ui-design.test.ts checks every pair.
//   - One font stack (system UI) and one monospace stack for commands and ids.
//   - Type scale 12 / 13 / 14 / 15 / 16 / 20 / 24 px. Spacing steps of 4 px.
//   - Risk is shown with colour, an icon and words together: "Looks around",
//     "Small change", "Big change", "Destructive".
//   - Inline SVG icons (no icon font, no external request: the CSP forbids them).
//   - Motion is subtle and off under prefers-reduced-motion.
//   - Focus rings on every control; 44px touch targets; mobile first. Below 900px
//     the navigation is a bottom tab bar; above, a sidebar.
//
// Seamless flows:
//   - Approve or deny from the list. Approve in one tap only where no owner password
//     is needed and the change is R0-R2; R3/R4 and password steps open the detail
//     screen, which shows the exact command before anything is sent.
//   - The owner password is asked inline on the same screen, never a page jump.
//   - Live updates arrive over the existing event stream; the screen re-reads the
//     broker, nothing is trusted from the stream payload.
//   - The last section a viewer used is remembered in localStorage (section name
//     only, read and written inside try/catch). It is ignored while anything waits.
//   - Secrets, tokens and passwords never appear in the URL, storage or the DOM.
//
// Everything below is the single source of colour, radius and spacing. The
// stylesheet is built from these tokens in css-components.ts and css-layout.ts.

export const TOKENS_CSS = `
:root {
  --font: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  --mono: ui-monospace, SFMono-Regular, Consolas, "Liberation Mono", monospace;
  --bg: #f3f5f9; --surface: #ffffff; --surface-2: #eef2f7;
  --ink: #111a2b; --ink-2: #4a5669;
  --line: #d6dde8; --line-strong: #aeb9c9;
  --accent: #1c5bc4; --accent-hover: #164ca8; --accent-ink: #ffffff;
  --accent-soft: #e5edfb; --accent-soft-ink: #163f8c;
  --ok: #14693a; --ok-bg: #e0f4e8;
  --warn: #834a00; --warn-bg: #fff0d2;
  --bad: #a81c2c; --bad-bg: #fce6e9; --bad-line: #e0a0aa;
  --untrusted: #5f2d9c; --untrusted-bg: #f2eafc;
  --focus: #1c5bc4;
  --shadow: 0 1px 2px rgb(17 26 43 / .06), 0 2px 10px rgb(17 26 43 / .05);
  --r-sm: 8px; --r: 12px; --r-lg: 18px; --r-pill: 999px;
  --touch: 44px; --ease: cubic-bezier(.2, .7, .2, 1);
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    --bg: #0b1017; --surface: #131a24; --surface-2: #1a2331;
    --ink: #e9eef6; --ink-2: #aab5c6;
    --line: #283445; --line-strong: #3c4a5e;
    --accent: #86b4ff; --accent-hover: #a3c6ff; --accent-ink: #0a1528;
    --accent-soft: #1b2c49; --accent-soft-ink: #c4dcff;
    --ok: #86e0b0; --ok-bg: #123024;
    --warn: #f5c372; --warn-bg: #3a2b10;
    --bad: #ffa2ac; --bad-bg: #3e1a22; --bad-line: #7a3a45;
    --untrusted: #d2b8ff; --untrusted-bg: #2a2040;
    --focus: #86b4ff;
    --shadow: 0 1px 2px rgb(0 0 0 / .4);
  }
}
:root[data-theme="dark"] {
  --bg: #0b1017; --surface: #131a24; --surface-2: #1a2331;
  --ink: #e9eef6; --ink-2: #aab5c6;
  --line: #283445; --line-strong: #3c4a5e;
  --accent: #86b4ff; --accent-hover: #a3c6ff; --accent-ink: #0a1528;
  --accent-soft: #1b2c49; --accent-soft-ink: #c4dcff;
  --ok: #86e0b0; --ok-bg: #123024;
  --warn: #f5c372; --warn-bg: #3a2b10;
  --bad: #ffa2ac; --bad-bg: #3e1a22; --bad-line: #7a3a45;
  --untrusted: #d2b8ff; --untrusted-bg: #2a2040;
  --focus: #86b4ff;
  --shadow: 0 1px 2px rgb(0 0 0 / .4);
}
`;
