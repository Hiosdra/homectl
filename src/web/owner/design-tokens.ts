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
  --bg: #f5f7fb; --surface: #ffffff; --surface-2: #edf1f8;
  --ink: #0f172a; --ink-2: #475569;
  --line: #dbe2ee; --line-strong: #b6c2d6;
  --accent: #1d4ed8; --accent-hover: #1e40af; --accent-ink: #ffffff;
  --accent-soft: #e6efff; --accent-soft-ink: #173a99;
  --ok: #0f6b40; --ok-bg: #dff6ea;
  --warn: #8a4b00; --warn-bg: #fff1d6;
  --bad: #b41d31; --bad-bg: #fde7ea; --bad-line: #e49aa5;
  --untrusted: #6328a8; --untrusted-bg: #f3ebff;
  --focus: #1d4ed8;
  --shadow: 0 1px 2px rgb(15 23 42 / .05), 0 6px 20px -6px rgb(15 23 42 / .08);
  --shadow-lg: 0 16px 40px -12px rgb(15 23 42 / .16), 0 2px 6px rgb(15 23 42 / .06);
  --r-sm: 10px; --r: 14px; --r-lg: 20px; --r-pill: 999px;
  --touch: 44px; --ease: cubic-bezier(.2, .8, .2, 1);
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    --bg: #090b10; --surface: #11151e; --surface-2: #181e2b;
    --ink: #f1f5fb; --ink-2: #9ba8bd;
    --line: #232c3d; --line-strong: #37455e;
    --accent: #6ea8ff; --accent-hover: #8cbaff; --accent-ink: #071224;
    --accent-soft: #152542; --accent-soft-ink: #c2dcff;
    --ok: #6ee7b7; --ok-bg: #0d2b22;
    --warn: #fbbf24; --warn-bg: #332409;
    --bad: #fb7185; --bad-bg: #38131d; --bad-line: #7a2e42;
    --untrusted: #c4b5fd; --untrusted-bg: #23193b;
    --focus: #6ea8ff;
    --shadow: 0 1px 2px rgb(0 0 0 / .45), 0 8px 24px -10px rgb(0 0 0 / .6);
    --shadow-lg: 0 24px 48px -14px rgb(0 0 0 / .75), 0 2px 8px rgb(0 0 0 / .45);
  }
}
:root[data-theme="dark"] {
  --bg: #090b10; --surface: #11151e; --surface-2: #181e2b;
  --ink: #f1f5fb; --ink-2: #9ba8bd;
  --line: #232c3d; --line-strong: #37455e;
  --accent: #6ea8ff; --accent-hover: #8cbaff; --accent-ink: #071224;
  --accent-soft: #152542; --accent-soft-ink: #c2dcff;
  --ok: #6ee7b7; --ok-bg: #0d2b22;
  --warn: #fbbf24; --warn-bg: #332409;
  --bad: #fb7185; --bad-bg: #38131d; --bad-line: #7a2e42;
  --untrusted: #c4b5fd; --untrusted-bg: #23193b;
  --focus: #6ea8ff;
  --shadow: 0 1px 2px rgb(0 0 0 / .45), 0 8px 24px -10px rgb(0 0 0 / .6);
  --shadow-lg: 0 24px 48px -14px rgb(0 0 0 / .75), 0 2px 8px rgb(0 0 0 / .45);
}
`;
