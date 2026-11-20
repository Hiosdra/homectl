// Static shell of the owner panel: the document and its stylesheet. The app
// itself is the bundle served as /owner.js. Colours are tokens so light and dark
// themes share one set of rules.
export const OWNER_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>homectl owner</title>
<link rel="stylesheet" href="/owner.css">
</head>
<body>
<div id="root"></div>
<script type="module" src="/owner.js"></script>
</body>
</html>
`;

export const OWNER_CSS = `
:root {
  --bg: #f6f7f9; --panel: #ffffff; --ink: #14181f; --muted: #5b6472;
  --line: #d9dde4; --accent: #1f5fbf; --accent-ink: #ffffff;
  --warn: #8a5300; --warn-bg: #fff4dc; --bad: #a11d2e; --bad-bg: #fde8eb;
  --good: #1d6b3a; --good-bg: #e3f5ea; --untrusted: #6b3fa0; --untrusted-bg: #f3ecfb;
  --mono: ui-monospace, SFMono-Regular, Consolas, "Liberation Mono", monospace;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    --bg: #0f1216; --panel: #171c23; --ink: #e8ecf2; --muted: #9aa4b2;
    --line: #2a313b; --accent: #6aa2ff; --accent-ink: #0b1220;
    --warn: #f0b45a; --warn-bg: #3a2c12; --bad: #ff8a97; --bad-bg: #3d1820;
    --good: #7ad79a; --good-bg: #123322; --untrusted: #c7a6ff; --untrusted-bg: #2a1f3d;
  }
}
:root[data-theme="dark"] {
  --bg: #0f1216; --panel: #171c23; --ink: #e8ecf2; --muted: #9aa4b2;
  --line: #2a313b; --accent: #6aa2ff; --accent-ink: #0b1220;
  --warn: #f0b45a; --warn-bg: #3a2c12; --bad: #ff8a97; --bad-bg: #3d1820;
  --good: #7ad79a; --good-bg: #123322; --untrusted: #c7a6ff; --untrusted-bg: #2a1f3d;
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--ink);
  font: 15px/1.45 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
main, header, nav { padding-left: 16px; padding-right: 16px; }
header { display: flex; align-items: center; justify-content: space-between; gap: 12px;
  padding-top: 12px; padding-bottom: 12px; border-bottom: 1px solid var(--line); background: var(--panel);
  position: sticky; top: 0; z-index: 1; }
header h1 { font-size: 17px; margin: 0; }
nav { display: flex; gap: 6px; overflow-x: auto; padding-top: 8px; padding-bottom: 8px; }
nav button { white-space: nowrap; }
main { max-width: 880px; margin: 0 auto; padding-top: 16px; padding-bottom: 48px; }
h2 { font-size: 18px; margin: 4px 0 12px; }
h3 { font-size: 15px; margin: 16px 0 8px; }
section, .card { background: var(--panel); border: 1px solid var(--line); border-radius: 10px;
  padding: 14px; margin-bottom: 14px; }
.muted { color: var(--muted); }
.small { font-size: 13px; }
.row { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.between { justify-content: space-between; }
.stack > * + * { margin-top: 10px; }
button, .button { font: inherit; border: 1px solid var(--line); background: var(--panel); color: var(--ink);
  border-radius: 8px; padding: 8px 12px; min-height: 40px; cursor: pointer; }
button.primary { background: var(--accent); color: var(--accent-ink); border-color: var(--accent); }
button.danger { color: var(--bad); }
button.active { border-color: var(--accent); box-shadow: inset 0 0 0 1px var(--accent); }
button:disabled { opacity: .55; cursor: default; }
button:focus-visible, input:focus-visible, select:focus-visible, textarea:focus-visible, a:focus-visible {
  outline: 3px solid var(--accent); outline-offset: 2px; }
input, select, textarea { font: inherit; width: 100%; min-height: 40px; padding: 8px 10px;
  border: 1px solid var(--line); border-radius: 8px; background: var(--bg); color: var(--ink); }
textarea { min-height: 120px; font-family: var(--mono); font-size: 13px; }
textarea.masked { -webkit-text-security: disc; text-security: disc; }
label { display: block; font-weight: 600; font-size: 14px; margin-bottom: 4px; }
label .hint { font-weight: 400; color: var(--muted); }
.field + .field { margin-top: 12px; }
.badge { display: inline-flex; align-items: center; gap: 4px; border-radius: 999px; padding: 2px 9px;
  font-size: 12px; font-weight: 600; background: var(--bg); border: 1px solid var(--line); }
.badge.count { background: var(--accent); color: var(--accent-ink); border-color: var(--accent); }
.badge.warn { background: var(--warn-bg); color: var(--warn); border-color: transparent; }
.badge.bad { background: var(--bad-bg); color: var(--bad); border-color: transparent; }
.badge.good { background: var(--good-bg); color: var(--good); border-color: transparent; }
.chips { display: flex; flex-wrap: wrap; gap: 6px; }
.chip { font-family: var(--mono); font-size: 13px; padding: 4px 8px; border-radius: 6px;
  background: var(--bg); border: 1px solid var(--line); word-break: break-all; }
.untrusted { border: 1px dashed var(--untrusted); background: var(--untrusted-bg); border-radius: 8px; padding: 10px; }
.untrusted .label { color: var(--untrusted); font-weight: 700; font-size: 12px; text-transform: uppercase; letter-spacing: .04em; }
.untrusted p { white-space: pre-wrap; word-break: break-word; margin: 6px 0 0; }
.notice { border-radius: 8px; padding: 10px 12px; border: 1px solid var(--line); }
.notice.warn { background: var(--warn-bg); color: var(--warn); border-color: transparent; }
.notice.bad { background: var(--bad-bg); color: var(--bad); border-color: transparent; }
.notice.good { background: var(--good-bg); color: var(--good); border-color: transparent; }
.item { display: flex; flex-direction: column; gap: 6px; padding: 12px 0; border-top: 1px solid var(--line); }
.item:first-child { border-top: 0; padding-top: 0; }
.plain-list { margin: 0; padding-left: 20px; }
.plain-list li + li { margin-top: 8px; }
details { margin-top: 8px; }
details > summary { cursor: pointer; color: var(--accent); font-weight: 600; min-height: 32px;
  display: inline-flex; align-items: center; border-radius: 6px; }
details[open] > summary { margin-bottom: 8px; }
summary:focus-visible { outline: 3px solid var(--accent); outline-offset: 2px; }
.details, .advanced { margin-top: 12px; }
.why { margin-top: 6px; }
a { color: var(--accent); }
table { width: 100%; border-collapse: collapse; font-size: 14px; }
th, td { text-align: left; padding: 8px 6px; border-top: 1px solid var(--line); vertical-align: top; }
th { color: var(--muted); font-weight: 600; }
code, .mono { font-family: var(--mono); font-size: 13px; word-break: break-all; }
pre.copy { font-family: var(--mono); font-size: 13px; background: var(--bg); border: 1px solid var(--line);
  border-radius: 8px; padding: 10px; white-space: pre-wrap; word-break: break-all; margin: 8px 0; }
dl { display: grid; grid-template-columns: max-content 1fr; gap: 6px 12px; margin: 0; }
dt { color: var(--muted); }
dd { margin: 0; word-break: break-word; }
.context-switcher { margin-bottom: 12px; }
.context-switcher label { margin: 0; }
.context-switcher select { width: auto; flex: 1 1 200px; max-width: 100%; }
.center { min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 16px; }
.center section { width: 100%; max-width: 380px; }
.dialog-backdrop { position: fixed; inset: 0; background: rgba(0,0,0,.35); display: flex;
  align-items: flex-end; justify-content: center; z-index: 5; }
.dialog-backdrop > div { background: var(--panel); border: 1px solid var(--line); border-radius: 14px 14px 0 0;
  padding: 16px; width: 100%; max-width: 560px; max-height: 90vh; overflow: auto; }
@media (min-width: 720px) {
  .dialog-backdrop { align-items: center; }
  .dialog-backdrop > div { border-radius: 14px; }
}
.sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); }
@media (max-width: 480px) {
  dl { grid-template-columns: 1fr; }
  table { font-size: 13px; }
  th.hide-sm, td.hide-sm { display: none; }
}
`;
