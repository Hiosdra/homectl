// Styles for the AI helper onboarding sheet and its model picker. Colours are
// tokens from design-tokens.ts, so light and dark share these rules. Phones get a
// full-screen sheet; wider screens get a centred dialog.
export const AI_HELPER_CSS = `
.mono { font-family: var(--mono); font-size: 13px; overflow-wrap: anywhere; }

.dialog-backdrop > .ai-helper-sheet { max-height: 100dvh; height: 100dvh; border-radius: 0;
  padding-top: calc(12px + env(safe-area-inset-top)); }
@media (min-width: 720px) {
  .dialog-backdrop > .ai-helper-sheet { height: auto; max-height: 90vh; max-width: 640px;
    border-radius: var(--r-lg); padding-top: 24px; }
}
.ai-helper-sheet h3 { font-size: 16px; margin-top: 18px; }
.ai-helper-sheet section + section { border-top: 1px solid var(--line); padding-top: 4px; }
.sheet-actions { justify-content: flex-end; }

.segmented { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 8px; }
.segmented button { flex: 1 1 120px; }
.segmented button[aria-pressed="true"], .segmented button[aria-checked="true"] {
  border-color: var(--accent); box-shadow: inset 0 0 0 1px var(--accent); background: var(--accent-soft);
  color: var(--accent-soft-ink); }

.model-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 8px;
  max-height: 340px; overflow: auto; padding-right: 2px; }
.model-card { display: flex; gap: 12px; align-items: flex-start; min-height: var(--touch); padding: 12px 14px;
  border: 1px solid var(--line-strong); border-radius: var(--r-sm); background: var(--surface); cursor: pointer;
  color: var(--ink); }
.model-card:hover { background: var(--surface-2); }
.model-card.selected { border-color: var(--accent); box-shadow: inset 0 0 0 1px var(--accent); }
.model-card > input[type="radio"] { width: auto; min-height: 0; margin-top: 4px; flex: none; }
.model-text { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
.model-name { font-weight: 650; font-size: 15px; }
.model-id { color: var(--ink-2); }
.model-badges { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 2px; }
.model-badges .badge { min-height: 22px; padding: 1px 8px; font-size: 12px; }
.model-price { color: var(--ink-2); }
.model-desc { overflow-wrap: anywhere; }
`;
