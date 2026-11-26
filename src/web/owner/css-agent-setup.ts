// Styles of the "Let your AI agent set it up" path: the two-card choice on Welcome,
// the assistant cards and stages of the agent page, and the link-style switch between
// the paths. Colours are design tokens and widths are fluid (the cards wrap to one
// column at phone width), with no inline styles, which the panel's CSP forbids.
export const AGENT_SETUP_CSS = `
.path-choice { margin: 18px 0 4px; }
.path-choice h3 { margin: 0 0 4px; }
.path-cards { display: grid; gap: 12px; grid-template-columns: repeat(auto-fit, minmax(min(240px, 100%), 1fr)); margin-top: 10px; }
.path-card { display: grid; gap: 6px; align-content: start; justify-items: start; text-align: left; min-height: var(--touch);
  padding: 14px; border: 1px solid var(--line-strong); border-radius: var(--r-sm); background: var(--surface); color: var(--ink);
  font: inherit; cursor: pointer; min-width: 0; overflow-wrap: anywhere; }
.path-card:hover:not(:disabled) { background: var(--surface-2); }
.path-card:focus-visible { outline: 3px solid var(--focus); outline-offset: 2px; }
.path-card:disabled { opacity: 0.6; cursor: progress; }
.path-card.is-chosen { border-color: var(--accent); box-shadow: inset 0 0 0 1px var(--accent); }
.path-card-title { font-weight: 700; font-size: 16px; }
.path-switch-line { margin: 18px 0 0; }
.setup-link-button { background: none; border: 0; padding: 8px 0; min-height: var(--touch); color: var(--accent);
  text-decoration: underline; cursor: pointer; font: inherit; text-align: left; }
.setup-link-button:disabled { opacity: 0.6; cursor: progress; }
.setup-link-button:focus-visible { outline: 3px solid var(--focus); outline-offset: 2px; border-radius: 4px; }
.agent-stage { margin-top: 16px; }
.agent-stage h3 { margin: 0 0 6px; }
.agent-stage .path-cards { margin-top: 8px; }
.agent-done .notice { margin-bottom: 12px; }
.setup-command code { overflow-wrap: anywhere; white-space: pre-wrap; }
.setup-prompt p { overflow-wrap: anywhere; }
`;
