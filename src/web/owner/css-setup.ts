// Styles of the guided setup: the wizard page, its step list, the checklist card on
// Needs you, the upgrade notice and the setup links. Colours are design tokens, so the
// light and dark themes share these rules. Widths are fluid: no inline styles, which
// the panel's content security policy forbids.
export const SETUP_CSS = `
.setup-summary { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; margin: 0 0 16px; color: var(--ink-2); }
.setup-progress { appearance: none; -webkit-appearance: none; width: min(320px, 100%); height: 10px;
  border: 0; border-radius: var(--r-pill); background: var(--line); overflow: hidden; }
.setup-progress::-webkit-progress-bar { background: var(--line); border-radius: var(--r-pill); }
.setup-progress::-webkit-progress-value { background: var(--accent); border-radius: var(--r-pill); }
.setup-progress::-moz-progress-bar { background: var(--accent); border-radius: var(--r-pill); }

.setup-layout { display: grid; gap: 16px; grid-template-columns: 1fr; }
.setup-rail ol { list-style: none; margin: 0; padding: 0; display: grid; gap: 6px; }
.setup-rail-item { display: flex; align-items: center; gap: 10px; padding: 8px 10px; min-height: var(--touch);
  border-radius: var(--r-sm); border: 1px solid transparent; color: var(--ink); text-decoration: none; font-weight: 600; font-size: 14px; }
.setup-rail-item:hover { background: var(--surface-2); }
.setup-rail-item.is-current { border-color: var(--line-strong); background: var(--surface); box-shadow: var(--shadow); }
.setup-rail-num { display: inline-grid; place-items: center; width: 24px; height: 24px; border-radius: 50%;
  background: var(--surface-2); color: var(--ink-2); font-size: 12px; flex: none; }
.setup-rail-name { flex: 1; min-width: 0; }
.setup-card { margin-bottom: 0; }
.setup-card .lead { margin-bottom: 14px; }
a.button { text-decoration: none; }
a.button.primary { background: var(--accent); border-color: var(--accent); color: var(--accent-ink); }
a.button.primary:hover { background: var(--accent-hover); border-color: var(--accent-hover); }
.setup-step-title { font-size: 22px; font-weight: 700; margin: 4px 0 8px; }
.setup-step-title:focus { outline: none; }
.setup-step-title:focus-visible { outline: 3px solid var(--focus); outline-offset: 2px; border-radius: 4px; }
.setup-card h4 { margin-top: 18px; }
.setup-foot { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; margin-top: 16px; }
.setup-foot .primary { margin-left: auto; }
.setup-details { margin: 14px 0 0; border-top: 1px solid var(--line); padding-top: 10px; }
.setup-details > summary { cursor: pointer; font-weight: 600; color: var(--ink-2); min-height: var(--touch); display: flex; align-items: center; }
.setup-command { display: flex; flex-wrap: wrap; gap: 8px 12px; align-items: center; margin: 8px 0 12px; }
.setup-command code { flex: 1 1 260px; min-width: 0; overflow-wrap: break-word; padding: 10px 12px; border-radius: var(--r-sm);
  background: var(--surface-2); border: 1px solid var(--line); font-family: var(--mono); font-size: 13px; }
.setup-command p { flex-basis: 100%; margin: 0; }
.setup-prompt { border: 1px solid var(--line); border-radius: var(--r-sm); padding: 12px; margin: 8px 0 12px; background: var(--surface-2); }
.setup-prompt p { margin-bottom: 10px; }
.setup-choices { display: grid; gap: 12px; grid-template-columns: 1fr; margin: 12px 0; }
.setup-choice { border: 1px solid var(--line); border-radius: var(--r); padding: 14px; background: var(--surface);
  display: flex; flex-direction: column; }
.setup-choice h3 { margin-bottom: 6px; }
.setup-choice .button, .setup-choice button { margin-top: auto; align-self: flex-start; }
.setup-waiting { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-top: 12px; color: var(--ink-2); }
.setup-link { font-weight: 600; white-space: nowrap; }

.setup-checklist { border-left: 4px solid var(--accent); }
.setup-list { list-style: none; margin: 10px 0 0; padding: 0; display: grid; gap: 4px; }
.setup-list-item { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px; padding: 8px 0; border-top: 1px solid var(--line); }
.setup-list-name { flex: 1 1 180px; font-weight: 600; min-width: 0; }
.setup-collapsed { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 10px;
  background: var(--surface); border: 1px solid var(--line); border-radius: var(--r); padding: 12px 16px; margin-bottom: 16px; }
.setup-collapsed p { margin: 0; }
.upgrade-notice { background: var(--warn-bg); color: var(--ink); border: 1px solid var(--line); border-radius: var(--r);
  padding: 14px 16px; margin-bottom: 16px; }
.upgrade-notice h3 { margin-bottom: 6px; }
.upgrade-notice p { margin-bottom: 10px; }

@media (min-width: 900px) {
  .setup-layout { grid-template-columns: 240px minmax(0, 1fr); align-items: start; }
  .setup-choices { grid-template-columns: 1fr 1fr; }
}
@media (max-width: 899px) {
  /* On a phone the steps are one strip that scrolls inside its own box, so the page
     itself never scrolls sideways. */
  .setup-layout { grid-template-columns: minmax(0, 1fr); }
  .setup-rail { min-width: 0; }
  .setup-rail ol { display: flex; gap: 6px; overflow-x: auto; padding: 2px 2px 8px; }
  .setup-rail-item { flex: none; white-space: nowrap; min-height: 40px; }
  .setup-rail-item .badge { display: none; }
}
@media (max-width: 480px) {
  .setup-foot .primary { margin-left: 0; width: 100%; }
  .setup-foot > * { flex: 1 1 100%; }
}
`;
