// Static shell of the owner panel: the document and its stylesheet. The app
// itself is the bundle served as /owner.js. The stylesheet is assembled from
// three parts: tokens (design-tokens.ts), components and layout. Colours are
// tokens so light and dark themes share one set of rules.
import { AI_HELPER_CSS } from "./css-ai-helper";
import { COMPONENTS_CSS } from "./css-components";
import { LAYOUT_CSS } from "./css-layout";
import { MACHINES_CSS } from "./css-machines";
import { TOKENS_CSS } from "./design-tokens";

export const OWNER_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="light dark">
<meta name="theme-color" content="#f3f5f9" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#0b1017" media="(prefers-color-scheme: dark)">
<title>homectl owner</title>
<link rel="stylesheet" href="/owner.css">
</head>
<body>
<div id="root"></div>
<script type="module" src="/owner.js"></script>
</body>
</html>
`;

export const OWNER_CSS = [
  TOKENS_CSS,
  COMPONENTS_CSS,
  LAYOUT_CSS,
  AI_HELPER_CSS,
  MACHINES_CSS,
].join("\n");
