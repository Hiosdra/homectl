// Layout of the owner panel: the phone tab bar, the desktop sidebar, the centred
// sign-in card, and motion that respects prefers-reduced-motion. Mobile first:
// the base rules are for phones; a 900px breakpoint adds the sidebar. Bottom
// spacing on phones is the tab bar height plus the safe-area inset, so content
// never sits under the bar.
export const LAYOUT_CSS = `
:root { --tabbar-h: 76px; --sidebar-w: 264px; --column-max: 820px; }
.shell { min-height: 100vh; display: flex; flex-direction: column; }
html { scroll-padding-top: 80px; scroll-padding-bottom: calc(var(--tabbar-h) + 24px); }
/* On phones the sidebar wrapper is transparent: its parts keep their own fixed and
   sticky placement. On desktop it becomes one sticky column. */
.sidebar { display: contents; }
header.topbar { position: sticky; top: 0; z-index: 10; display: flex; align-items: center;
  justify-content: space-between; gap: 12px; padding: 10px 16px; background: var(--surface);
  border-bottom: 1px solid var(--line); }
.brand { display: flex; align-items: center; gap: 11px; min-width: 0; }
.brand h1 { font-size: 16px; font-weight: 750; letter-spacing: -.02em; white-space: nowrap; }
.brand-mark { width: 32px; height: 32px; border-radius: 10px;
  background: linear-gradient(135deg, var(--accent), var(--accent-hover)); color: var(--accent-ink);
  box-shadow: 0 4px 14px -4px var(--accent); display: grid; place-items: center; flex: none; }
.brand-mark .icon { width: 18px; height: 18px; }
.topbar-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; justify-content: flex-end; }
.topbar-actions .sign-out { min-height: 40px; padding: 6px 12px; }
.live-status { display: inline-flex; align-items: center; gap: 7px; font-size: 12.5px; font-weight: 650;
  color: var(--ink-2); white-space: nowrap; padding: 4px 10px; border-radius: var(--r-pill);
  background: var(--surface-2); border: 1px solid var(--line); }
.live-status .live-dot { width: 8px; height: 8px; background: var(--line-strong); }
.live-status.good { color: var(--ok); background: var(--ok-bg); border-color: transparent; }
.live-status.good .live-dot { background: var(--ok); }
.live-status.warn { color: var(--warn); background: var(--warn-bg); border-color: transparent; }
.live-status.warn .live-dot { background: var(--warn); }
.live-status.bad { color: var(--bad); background: var(--bad-bg); border-color: transparent; }
.live-status.bad .live-dot { background: var(--bad); }
.sidebar-foot { display: none; }

nav[aria-label="Owner sections"] { position: fixed; left: 0; right: 0; bottom: 0; z-index: 10; display: grid;
  grid-auto-flow: column; grid-auto-columns: minmax(0, 1fr); gap: 4px; height: var(--tabbar-h);
  padding: 6px 6px calc(6px + env(safe-area-inset-bottom));
  background: var(--surface); border-top: 1px solid var(--line); backdrop-filter: blur(14px); }
/* Columns never grow to fit a long label: six tabs must fit a 390px screen. */
nav[aria-label="Owner sections"] button { min-width: 0; flex-direction: column; gap: 3px; min-height: 58px; padding: 6px 2px;
  border: 0; border-radius: var(--r-sm); background: transparent; color: var(--ink-2); font-size: 12px;
  font-weight: 600; line-height: 1.2; position: relative; }
nav[aria-label="Owner sections"] button > span:not(.nav-count) { min-width: 0; overflow-wrap: anywhere; text-align: center; }
nav[aria-label="Owner sections"] button:hover:not(:disabled) { background: var(--surface-2); color: var(--ink); }
nav[aria-label="Owner sections"] button .icon { width: 21px; height: 21px; }
nav[aria-label="Owner sections"] button.active { color: var(--accent-soft-ink); background: var(--accent-soft);
  box-shadow: none; font-weight: 700; }
nav[aria-label="Owner sections"] .nav-count { position: absolute; top: 4px; left: calc(50% + 6px); min-width: 18px;
  height: 18px; padding: 0 5px; border-radius: var(--r-pill); background: var(--accent); color: var(--accent-ink);
  font-size: 11px; line-height: 18px; text-align: center; font-variant-numeric: tabular-nums; }

main.main { flex: 1; width: 100%; max-width: var(--column-max); margin: 0 auto; min-width: 0;
  padding: 20px 16px calc(var(--tabbar-h) + env(safe-area-inset-bottom) + 24px); }
/* On phones the decision block scrolls with the page; only its action row stays in
   view above the tab bar, so the exact command is never covered. */
.decision-actions { position: sticky; bottom: calc(var(--tabbar-h) + env(safe-area-inset-bottom) - 1px); z-index: 5;
  margin: 12px -16px -14px; padding: 10px 16px 12px; background: var(--surface); border-top: 1px solid var(--line);
  box-shadow: 0 -6px 16px rgb(17 26 43 / .08); }
.decision-actions .request-actions { margin-top: 0; }

.center { min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 24px 16px;
  background: radial-gradient(circle at 50% 24%, var(--accent-soft) 0%, transparent 56%); }
.center > section { width: 100%; max-width: 440px; padding: 32px; border-radius: var(--r-lg); box-shadow: var(--shadow-lg); }
.center > section h2 { font-size: 20px; font-weight: 750; margin-bottom: 8px; text-align: center; }
.center > section > p.small { text-align: center; }
.center > section form { margin-top: 20px; }
.center > section form button[type="submit"] { width: 100%; min-height: 46px; font-size: 15px; }
.center .brand-large { display: flex; flex-direction: column; align-items: center; gap: 12px; margin-bottom: 20px;
  text-align: center; }
.center .brand-large .brand-mark { width: 54px; height: 54px; border-radius: 16px; }
.center .brand-large .brand-mark .icon { width: 28px; height: 28px; }
.center .brand-large h1 { font-size: 21px; letter-spacing: -.02em; }

.session-note { display: flex; gap: 8px; align-items: center; color: var(--ink-2); font-size: 13px; margin-top: 12px; }
.session-note .icon { width: 16px; height: 16px; }

@media (min-width: 900px) {
  .shell { display: grid; grid-template-columns: var(--sidebar-w) minmax(0, 1fr); align-items: start; }
  html { scroll-padding-bottom: 24px; }
  .sidebar { display: flex; grid-column: 1; grid-row: 1; flex-direction: column; position: sticky; top: 0;
    height: 100vh; overflow-y: auto; background: var(--surface); border-right: 1px solid var(--line); }
  header.topbar { flex-direction: column; align-items: stretch; gap: 14px; position: static; border-bottom: 1px solid var(--line);
    background: transparent; padding: 24px 20px 18px; margin-bottom: 8px; }
  header.topbar .brand h1 { font-size: 17px; }
  .topbar-actions { justify-content: flex-start; }
  header.topbar .sign-out-top { display: none; }
  nav[aria-label="Owner sections"] { position: static; height: auto; display: flex; flex-direction: column;
    gap: 4px; padding: 6px 12px; background: transparent; border: 0; backdrop-filter: none; }
  nav[aria-label="Owner sections"] button { flex-direction: row; justify-content: flex-start; gap: 12px;
    min-height: var(--touch); padding: 9px 14px; font-size: 14.5px; width: 100%; border-radius: var(--r-sm); }
  nav[aria-label="Owner sections"] button .icon { width: 19px; height: 19px; }
  nav[aria-label="Owner sections"] button.active { box-shadow: none; }
  nav[aria-label="Owner sections"] button.active::before { content: ""; position: absolute; left: 0; top: 9px; bottom: 9px;
    width: 3px; border-radius: 0 3px 3px 0; background: var(--accent); }
  nav[aria-label="Owner sections"] .nav-count { position: static; margin-left: auto; min-width: 22px;
    height: 22px; line-height: 22px; font-size: 12px; }
  .sidebar-foot { display: flex; margin-top: auto; padding: 14px 16px 20px; border-top: 1px solid var(--line); }
  .sidebar-foot .sign-out { width: 100%; justify-content: flex-start; min-height: var(--touch); color: var(--ink-2); }
  .sidebar-foot .sign-out:hover:not(:disabled) { color: var(--ink); background: var(--surface-2); }
  main.main { grid-column: 2; grid-row: 1; max-width: var(--column-max); padding: 40px 44px 72px; }
  .decision-actions { position: static; margin: 14px 0 0; padding: 0; background: transparent; border: 0; box-shadow: none; }
  .decision { position: static; margin: 0 0 16px; padding: 20px; border-radius: var(--r); border: 1px solid var(--line);
    box-shadow: var(--shadow); }
}

@media (prefers-reduced-motion: no-preference) {
  main.main { animation: owner-rise .22s var(--ease) backwards; }
  .dialog-backdrop > div { animation: owner-sheet .24s var(--ease) backwards; }
  .toast { animation: owner-rise .22s var(--ease) backwards; }
  .live-status.good .live-dot { animation: owner-pulse 2.6s ease-in-out infinite; }
  button, nav button, details > summary::after { transition-property: background-color, border-color, color, transform;
    transition-duration: .15s; }
}
@keyframes owner-rise { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }
@keyframes owner-sheet { from { opacity: 0; transform: translateY(24px); } to { opacity: 1; transform: none; } }
@keyframes owner-pulse { 0%, 100% { opacity: 1; } 50% { opacity: .45; } }
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { animation: none !important; transition: none !important; scroll-behavior: auto !important; }
}

@media (max-width: 480px) {
  .topbar-actions { gap: 6px; flex-wrap: nowrap; }
  .sign-out .btn-text { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
  dl { grid-template-columns: 1fr; gap: 2px 0; }
  dl dt { margin-top: 10px; }
  table { font-size: 13px; }
  th.hide-sm, td.hide-sm { display: none; }
  table.stackable thead { display: none; }
  table.stackable, table.stackable tbody, table.stackable tr, table.stackable td { display: block; width: 100%; }
  table.stackable tr { padding: 12px 0; border-bottom: 1px solid var(--line); }
  table.stackable tr:last-child { border-bottom: 0; }
  table.stackable td { border: 0; padding: 4px 0; word-break: break-word; }
  table.stackable td button { width: auto; }
  .page-head h2 { font-size: 22px; }
  .item.request { padding: 14px; }
}
input, select, textarea { font-size: 16px; }
`;
