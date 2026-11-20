// Layout of the owner panel: the phone tab bar, the desktop sidebar, the centred
// sign-in card, and motion that respects prefers-reduced-motion. Mobile first:
// the base rules are for phones; a 900px breakpoint adds the sidebar.
export const LAYOUT_CSS = `
.shell { min-height: 100vh; display: flex; flex-direction: column; }
html { scroll-padding-top: 80px; scroll-padding-bottom: 104px; }
header.topbar { position: sticky; top: 0; z-index: 10; display: flex; align-items: center;
  justify-content: space-between; gap: 12px; padding: 10px 16px; background: var(--surface);
  border-bottom: 1px solid var(--line); }
.brand { display: flex; align-items: center; gap: 10px; min-width: 0; }
.brand h1 { font-size: 16px; font-weight: 700; white-space: nowrap; }
.brand-mark { width: 30px; height: 30px; border-radius: 9px; background: var(--accent); color: var(--accent-ink);
  display: grid; place-items: center; flex: none; }
.brand-mark .icon { width: 18px; height: 18px; }
.topbar-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; justify-content: flex-end; }
.topbar-actions button { min-height: 40px; padding: 6px 12px; }
.live-state { font-size: 12.5px; }

nav[aria-label="Owner sections"] { position: fixed; left: 0; right: 0; bottom: 0; z-index: 10; display: grid;
  grid-auto-flow: column; grid-auto-columns: 1fr; gap: 4px; padding: 6px 6px calc(6px + env(safe-area-inset-bottom));
  background: var(--surface); border-top: 1px solid var(--line); }
nav[aria-label="Owner sections"] button { flex-direction: column; gap: 3px; min-height: 58px; padding: 6px 2px;
  border: 0; border-radius: var(--r-sm); background: transparent; color: var(--ink-2); font-size: 12px;
  font-weight: 600; line-height: 1.2; position: relative; }
nav[aria-label="Owner sections"] button:hover:not(:disabled) { background: var(--surface-2); }
nav[aria-label="Owner sections"] button .icon { width: 22px; height: 22px; }
nav[aria-label="Owner sections"] button.active { color: var(--accent-soft-ink); background: var(--accent-soft);
  box-shadow: none; }
nav[aria-label="Owner sections"] .nav-count { position: absolute; top: 4px; left: calc(50% + 6px); min-width: 18px;
  height: 18px; padding: 0 5px; border-radius: var(--r-pill); background: var(--accent); color: var(--accent-ink);
  font-size: 11px; line-height: 18px; text-align: center; }

main.main { flex: 1; width: 100%; max-width: 760px; margin: 0 auto; padding: 20px 16px 120px; min-width: 0; }

.center { min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 24px 16px; }
.center > section { width: 100%; max-width: 420px; padding: 24px; }
.center .brand-large { display: flex; flex-direction: column; align-items: center; gap: 10px; margin-bottom: 18px;
  text-align: center; }
.center .brand-large .brand-mark { width: 48px; height: 48px; border-radius: 14px; }
.center .brand-large .brand-mark .icon { width: 26px; height: 26px; }
.center .brand-large h1 { font-size: 20px; }

.session-note { display: flex; gap: 8px; align-items: center; color: var(--ink-2); font-size: 13px; margin-top: 12px; }
.session-note .icon { width: 16px; height: 16px; }

@media (min-width: 900px) {
  .shell { display: grid; grid-template-columns: 252px minmax(0, 1fr); grid-template-rows: auto 1fr;
    align-items: start; }
  header.topbar { grid-column: 1; grid-row: 1; flex-direction: column; align-items: stretch; gap: 16px;
    position: static; border-bottom: 0; border-right: 1px solid var(--line); padding: 24px 16px 12px; }
  .topbar-actions { justify-content: flex-start; }
  nav[aria-label="Owner sections"] { position: static; align-self: stretch; grid-column: 1; grid-row: 2;
    display: flex; flex-direction: column; gap: 4px; padding: 8px 12px 24px; background: var(--surface); border: 0;
    border-right: 1px solid var(--line); border-top: 0; }
  nav[aria-label="Owner sections"] button { flex-direction: row; justify-content: flex-start; gap: 12px;
    min-height: var(--touch); padding: 8px 12px; font-size: 15px; width: 100%; }
  nav[aria-label="Owner sections"] button .icon { width: 20px; height: 20px; }
  nav[aria-label="Owner sections"] button.active { box-shadow: none; }
  nav[aria-label="Owner sections"] .nav-count { position: static; margin-left: auto; min-width: 22px;
    height: 22px; line-height: 22px; font-size: 12px; }
  main.main { grid-column: 2; grid-row: 1 / span 2; max-width: 860px; padding: 36px 44px 72px; }
}

@media (prefers-reduced-motion: no-preference) {
  main.main { animation: owner-rise .22s var(--ease) backwards; }
  .dialog-backdrop > div { animation: owner-sheet .24s var(--ease) backwards; }
  .toast { animation: owner-rise .22s var(--ease) backwards; }
  button, nav button, details > summary::after { transition-property: background-color, border-color, color, transform;
    transition-duration: .15s; }
}
@keyframes owner-rise { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }
@keyframes owner-sheet { from { opacity: 0; transform: translateY(24px); } to { opacity: 1; transform: none; } }
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { animation: none !important; transition: none !important; scroll-behavior: auto !important; }
}

@media (max-width: 480px) {
  .topbar .brand .badge { display: none; }
  .topbar-actions { gap: 6px; flex-wrap: nowrap; }
  .topbar-actions .badge { padding: 2px 8px; }
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
