// Styles for the Machines screen and its add sheet. Colours are the shared tokens
// from design-tokens.ts, so light and dark themes follow automatically. No inline
// styles: the CSP forbids them, so the progress bar reads a data attribute.
export const MACHINES_CSS = `
.plain-fieldset { border: 0; margin: 0; padding: 0; min-width: 0; }
.plain-fieldset legend { padding: 0; }
.problem { color: var(--bad); margin: 6px 0 0; }
.machines-bar { margin-bottom: 14px; }
.machine-card { display: flex; flex-direction: column; gap: 8px; }
.machine-card .request-head { align-items: flex-start; }
.machine-name { font-size: 18px; overflow-wrap: anywhere; }
.machine-badges { display: flex; flex-wrap: wrap; gap: 6px; justify-content: flex-end; }
.machine-address { color: var(--ink-2); overflow-wrap: anywhere; margin: 0; }
.machine-facts { margin: 4px 0 0; display: grid; gap: 10px; border-top: 1px solid var(--line); padding-top: 12px; }
.machine-facts > div { display: grid; gap: 2px; }
.machine-facts dt { font-size: 13px; color: var(--ink-2); font-weight: 600; }
.machine-facts dd { margin: 0; overflow-wrap: anywhere; }
.empty-machines { border: 1px dashed var(--line-strong); border-radius: var(--r); padding: 18px; color: var(--ink-2); }
.empty-machines p { margin: 0; }
.key-panel { display: grid; gap: 8px; }
.key-block { font-family: var(--mono); font-size: 13px; line-height: 1.5; white-space: pre-wrap; overflow-wrap: anywhere;
  background: var(--surface-2); border: 1px solid var(--line); border-radius: var(--r-sm); padding: 10px 12px; margin: 0; }
.command-block { display: grid; gap: 8px; margin: 8px 0; }
.check-path { border-left: 3px solid var(--accent); background: var(--accent-soft); color: var(--accent-soft-ink);
  border-radius: var(--r-sm); padding: 10px 12px; margin-top: 8px; }
.check-path .label { color: inherit; }
.key-list { display: grid; gap: 10px; margin: 0 0 12px; padding: 0; }
.key-row { display: grid; gap: 6px; border: 1px solid var(--line); border-radius: var(--r-sm); padding: 10px 12px; }
.key-fingerprint { overflow-wrap: anywhere; font-size: 13.5px; }
.match { font-size: 14px; margin: 8px 0 12px; color: var(--ink-2); }
.match.good { color: var(--ok); font-weight: 650; }
.step-bar { height: 6px; border-radius: 6px; background: var(--surface-2); overflow: hidden; margin: 0 0 12px; }
.step-bar span { display: block; height: 100%; background: var(--accent); border-radius: 6px; }
.step-bar span[data-step="1"] { width: 20%; }
.step-bar span[data-step="2"] { width: 40%; }
.step-bar span[data-step="3"] { width: 60%; }
.step-bar span[data-step="4"] { width: 80%; }
.step-bar span[data-step="5"] { width: 100%; }
.machine-sheet { max-height: 88vh; overflow-y: auto; }
.machine-sheet .wizard-title:focus { outline: none; }
.machine-sheet .wizard-title:focus-visible { outline: 3px solid var(--focus); outline-offset: 2px; }
.machine-sheet .plain-steps .command-block pre { font-size: 12.5px; }
`;
