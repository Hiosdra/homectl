// Components of the owner panel stylesheet: type, cards, buttons, badges, notices,
// forms, tables, disclosure, dialogs and toasts. Every colour is a token from
// design-tokens.ts, so the light and dark themes share these rules.
export const COMPONENTS_CSS = `
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--ink); font: 15px/1.5 var(--font);
  -webkit-text-size-adjust: 100%; -webkit-font-smoothing: antialiased; }
h1, h2, h3, h4 { margin: 0; line-height: 1.25; color: var(--ink); letter-spacing: -.01em; }
h3 { font-size: 16px; font-weight: 650; margin-bottom: 10px; }
h4 { font-size: 14px; font-weight: 650; margin: 16px 0 8px; }
p { margin: 0 0 10px; }
p:last-child { margin-bottom: 0; }
.page-head { margin: 4px 0 20px; }
.page-head h2 { font-size: 24px; font-weight: 700; margin-bottom: 6px; }
.page-head p { color: var(--ink-2); margin: 0; max-width: 62ch; }
.muted { color: var(--ink-2); }
.small { font-size: 13px; }
.row { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; }
.between { justify-content: space-between; }
.stack > * + * { margin-top: 12px; }
.lead { font-size: 16px; margin: 0 0 6px; }
.sub-title { font-size: 13px; font-weight: 650; color: var(--ink-2); margin: 14px 0 6px; }
section, .card { background: var(--surface); border: 1px solid var(--line); border-radius: var(--r);
  padding: 18px; margin-bottom: 16px; box-shadow: var(--shadow); }
section:last-child { margin-bottom: 0; }
a { color: var(--accent); font-weight: 600; }

button, .button { font: inherit; font-size: 14px; font-weight: 600; display: inline-flex; align-items: center;
  justify-content: center; gap: 8px; min-height: var(--touch); padding: 8px 16px; border-radius: var(--r-sm);
  border: 1px solid var(--line-strong); background: var(--surface); color: var(--ink); cursor: pointer;
  transition: background-color .15s var(--ease), border-color .15s var(--ease), color .15s var(--ease); }
button:hover:not(:disabled) { background: var(--surface-2); }
button.primary { background: var(--accent); border-color: var(--accent); color: var(--accent-ink); }
button.primary:hover:not(:disabled) { background: var(--accent-hover); border-color: var(--accent-hover); }
button.danger { color: var(--bad); border-color: var(--bad-line); }
button.danger:hover:not(:disabled) { background: var(--bad-bg); }
button.quiet { background: transparent; border-color: transparent; color: var(--accent); }
button.quiet:hover:not(:disabled) { background: var(--accent-soft); }
button.active { border-color: var(--accent); box-shadow: inset 0 0 0 1px var(--accent); }
/* A disabled control keeps its colour family and readable text; it is only dimmed
   and loses the pointer, so it still reads as the same button. */
button:disabled { opacity: .62; cursor: not-allowed; }
button.primary:disabled { background: var(--surface-2); border-color: var(--line-strong); color: var(--ink-2); opacity: 1; }
.icon { width: 20px; height: 20px; flex: none; fill: none; stroke: currentColor; stroke-width: 2;
  stroke-linecap: round; stroke-linejoin: round; }
:focus-visible { outline: 3px solid var(--focus); outline-offset: 2px; }

.badge { display: inline-flex; align-items: center; gap: 6px; min-height: 26px; padding: 2px 10px;
  border-radius: var(--r-pill); font-size: 12.5px; font-weight: 600; white-space: nowrap;
  background: var(--surface-2); color: var(--ink-2); border: 1px solid var(--line); }
.badge .icon { width: 14px; height: 14px; stroke-width: 2.4; }
.badge.count { background: var(--accent); color: var(--accent-ink); border-color: transparent; }
.badge.info { background: var(--accent-soft); color: var(--accent-soft-ink); border-color: transparent; }
.badge.warn { background: var(--warn-bg); color: var(--warn); border-color: transparent; }
.badge.bad { background: var(--bad-bg); color: var(--bad); border-color: transparent; }
.badge.good { background: var(--ok-bg); color: var(--ok); border-color: transparent; }
.live-dot { width: 8px; height: 8px; border-radius: 50%; background: currentColor; display: inline-block; }

.notice { display: flex; gap: 10px; align-items: flex-start; border-radius: var(--r-sm); padding: 12px 14px;
  border: 1px solid var(--line); background: var(--surface-2); color: var(--ink); margin: 0 0 14px; }
.notice .icon { width: 18px; height: 18px; margin-top: 1px; }
.notice-body { flex: 1; min-width: 0; }
.notice-body > * + * { margin-top: 8px; }
.notice.warn { background: var(--warn-bg); color: var(--ink); border-color: transparent; }
.notice.warn .icon { color: var(--warn); }
.notice.bad { background: var(--bad-bg); color: var(--ink); border-color: transparent; }
.notice.bad .icon { color: var(--bad); }
.notice.good { background: var(--ok-bg); color: var(--ink); border-color: transparent; }
.notice.good .icon { color: var(--ok); }

.item { display: flex; flex-direction: column; gap: 8px; padding: 16px 0; border-top: 1px solid var(--line); }
.item:first-child { border-top: 0; padding-top: 0; }
.item.request { border: 1px solid var(--line); border-top-width: 1px; border-left: 4px solid var(--line-strong);
  border-radius: var(--r); padding: 16px; margin-bottom: 12px; background: var(--surface); box-shadow: var(--shadow); }
.item.request:last-child { margin-bottom: 0; }
.item > p, .request-head + p { margin: 0; }
.request-actions + p { margin-top: 2px; }
.lead { margin: 0; }
.item.request[data-risk="look"] { border-left-color: var(--accent); }
.item.request[data-risk="small"] { border-left-color: var(--ok); }
.item.request[data-risk="big"] { border-left-color: var(--warn); }
.item.request[data-risk="destructive"] { border-left-color: var(--bad); }
.request-head { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; justify-content: space-between; }
.request-meta { color: var(--ink-2); font-size: 13px; margin: 0; }
.request-actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 4px; }
.command { font-family: var(--mono); font-size: 15px; font-weight: 600; color: var(--ink); background: var(--surface-2);
  border: 1px solid var(--line); border-radius: var(--r-sm); padding: 2px 8px; word-break: break-word; }
.command-line { margin: 0; }
.plain-list { margin: 0; padding-left: 20px; }
.plain-list li + li { margin-top: 8px; }

/* Needs you: one list of cards under one heading each. The cards carry the only
   border, so nothing sits inside a bordered container. */
.group + .group { margin-top: 24px; }
.group-title { display: flex; align-items: center; gap: 8px; font-size: 16px; margin-bottom: 10px; }
.request-list { display: flex; flex-direction: column; gap: 12px; }
.item.request-card, .request-card { display: flex; flex-direction: column; gap: 8px; padding: 16px 18px; margin: 0;
  background: var(--surface); border: 1px solid var(--line); border-left: 4px solid var(--line-strong);
  border-radius: var(--r); box-shadow: var(--shadow); }
.item.request-card { padding-top: 16px; }
.item.request-card[data-risk="look"] { border-left-color: var(--accent); }
.item.request-card[data-risk="small"] { border-left-color: var(--ok); }
.item.request-card[data-risk="big"] { border-left-color: var(--warn); }
.item.request-card[data-risk="destructive"] { border-left-color: var(--bad); }
.assistant-tag { display: inline-flex; align-items: center; gap: 8px; font-size: 14px; font-weight: 650; color: var(--ink-2); }
.assistant-tag .icon { width: 18px; height: 18px; color: var(--accent); }

.chips { display: flex; flex-wrap: wrap; gap: 6px; }
.chip { font-family: var(--mono); font-size: 14px; padding: 4px 10px; border-radius: 6px; background: var(--surface-2);
  border: 1px solid var(--line); word-break: break-all; }
.command-block { background: var(--surface-2); border: 1px solid var(--line); border-radius: var(--r-sm); padding: 12px; }
.untrusted { border: 1px dashed var(--untrusted); background: var(--untrusted-bg); border-radius: var(--r-sm); padding: 12px 14px; }
.untrusted .label { color: var(--untrusted); font-weight: 700; font-size: 12px; text-transform: uppercase; letter-spacing: .04em; }
.untrusted p { white-space: pre-wrap; word-break: break-word; margin: 6px 0 0; }

details { margin-top: 10px; }
details > summary { cursor: pointer; list-style: none; color: var(--accent); font-weight: 600; min-height: 44px;
  display: inline-flex; align-items: center; gap: 8px; border-radius: 6px; }
details > summary::-webkit-details-marker { display: none; }
details > summary::after { content: ""; width: 7px; height: 7px; border-right: 2px solid currentColor;
  border-bottom: 2px solid currentColor; transform: rotate(45deg) translateY(-2px); transition: transform .15s var(--ease); }
details[open] > summary::after { transform: rotate(225deg) translateY(-2px); }
details[open] > summary { margin-bottom: 8px; }
.details, .advanced { margin-top: 12px; }
.more-options > summary { margin-top: 2px; }
.option-row { display: grid; gap: 4px; }
.option-row > button { justify-self: start; }
.why { margin-top: 6px; }

table { width: 100%; border-collapse: collapse; font-size: 14px; }
th, td { text-align: left; padding: 12px 8px; border-bottom: 1px solid var(--line); vertical-align: top; }
th { color: var(--ink-2); font-weight: 600; font-size: 12.5px; }
td .why { font-size: 14px; }

code, .mono { font-family: var(--mono); font-size: 13.5px; word-break: break-all; }
pre.copy { font-family: var(--mono); font-size: 13px; background: var(--surface-2); border: 1px solid var(--line);
  border-radius: var(--r-sm); padding: 12px; white-space: pre-wrap; word-break: break-all; margin: 8px 0; }
dl { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: 10px 18px; margin: 0; align-items: baseline; }
dt { color: var(--ink-2); font-size: 14px; }
dd { margin: 0; word-break: break-word; }

.field + .field { margin-top: 14px; }
label { display: block; font-weight: 600; font-size: 14px; margin-bottom: 6px; color: var(--ink); }
label .hint { font-weight: 400; color: var(--ink-2); }
input, select, textarea { font: inherit; font-size: 16px; width: 100%; min-height: var(--touch); padding: 10px 12px;
  border: 1px solid var(--line-strong); border-radius: var(--r-sm); background: var(--surface); color: var(--ink); }
input[type="radio"], input[type="checkbox"] { width: 20px; height: 20px; min-height: 20px; margin: 0; accent-color: var(--accent); }
textarea { min-height: 120px; font-family: var(--mono); font-size: 14px; }
textarea.masked { -webkit-text-security: disc; text-security: disc; }
fieldset { border: 1px solid var(--line); border-radius: var(--r-sm); padding: 12px 14px; margin: 14px 0 0; }
legend { font-weight: 650; padding: 0 6px; }

/* Radio rows: the control and its words side by side, the whole row tappable. */
.radio-group { display: flex; flex-direction: column; gap: 10px; margin-top: 8px; }
.radio-row { display: flex; gap: 12px; align-items: flex-start; min-height: var(--touch); margin: 0; padding: 14px;
  border: 1px solid var(--line-strong); border-radius: var(--r-sm); background: var(--surface); color: var(--ink);
  font-weight: 500; cursor: pointer; }
.radio-row:hover { background: var(--surface-2); }
.radio-row input { margin-top: 3px; flex: none; }
.radio-row.selected { border-color: var(--accent); box-shadow: inset 0 0 0 1px var(--accent); }
.radio-text { display: flex; flex-direction: column; min-width: 0; }
.radio-title { font-size: 15px; font-weight: 650; color: var(--ink); }
.radio-detail { font-size: 13.5px; color: var(--ink-2); margin-top: 2px; font-weight: 400; }
.check-row { display: flex; gap: 12px; align-items: center; min-height: var(--touch); margin: 0; padding: 6px 4px;
  font-weight: 500; font-size: 15px; cursor: pointer; }
.check-row input { flex: none; }
.copy-control { display: inline-flex; flex-wrap: wrap; gap: 10px; align-items: center; }
.plain-steps { margin: 0; padding-left: 20px; }
.plain-steps > li + li { margin-top: 12px; }
.plain-steps .copy { margin-top: 8px; }
.removed-list { margin-top: 16px; }
.removed-list h4 { margin-top: 0; }
.assistant-card .assistant-name { font-size: 16px; font-weight: 700; color: var(--ink); }
.assistant-card .assistant-tag { font-size: 16px; color: var(--ink); }

.context-switcher { margin-bottom: 16px; padding: 12px 14px; background: var(--surface); border: 1px solid var(--line);
  border-radius: var(--r); }
.context-switcher label { margin: 0; }
.context-switcher select { width: auto; flex: 1 1 200px; max-width: 100%; }

.empty { text-align: center; padding: 28px 12px; }
.empty .empty-mark { width: 56px; height: 56px; border-radius: 50%; background: var(--ok-bg); color: var(--ok);
  display: grid; place-items: center; margin: 0 auto 14px; }
.empty .empty-mark .icon { width: 28px; height: 28px; }
.empty h3 { margin-bottom: 6px; font-size: 18px; }
.empty p { color: var(--ink-2); max-width: 46ch; margin: 0 auto; }
.empty .row { justify-content: center; margin-top: 16px; }

.dialog-backdrop { position: fixed; inset: 0; background: rgb(8 12 20 / .55); display: flex;
  align-items: flex-end; justify-content: center; z-index: 50; }
.dialog-backdrop > div { background: var(--surface); border: 1px solid var(--line); border-radius: 18px 18px 0 0;
  padding: 10px 20px calc(20px + env(safe-area-inset-bottom)); width: 100%; max-width: 580px; max-height: 90vh;
  overflow: auto; box-shadow: 0 -10px 40px rgb(0 0 0 / .25); }
.dialog-backdrop > div::before { content: ""; display: block; width: 40px; height: 4px; border-radius: 4px;
  background: var(--line-strong); margin: 0 auto 14px; }
.dialog-backdrop h2 { font-size: 20px; margin-bottom: 10px; }
@media (min-width: 720px) {
  .dialog-backdrop { align-items: center; }
  .dialog-backdrop > div { border-radius: var(--r-lg); padding: 24px; }
  .dialog-backdrop > div::before { display: none; }
}

.toast { position: fixed; left: 12px; right: 12px; bottom: calc(var(--tabbar-h) + env(safe-area-inset-bottom) + 8px);
  z-index: 40; max-width: 560px; margin: 0 auto; display: flex; gap: 12px; align-items: center;
  justify-content: space-between; background: var(--ink); color: var(--bg); border-radius: var(--r); padding: 12px 12px 12px 16px;
  box-shadow: 0 10px 30px rgb(0 0 0 / .25); }
.toast p { margin: 0; font-size: 15px; font-weight: 550; }
.toast button { min-height: 44px; background: transparent; color: var(--bg); border-color: transparent; }
.toast button:hover:not(:disabled) { background: rgb(128 128 128 / .2); }
@media (min-width: 900px) { .toast { bottom: 24px; } }

.sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
`;
