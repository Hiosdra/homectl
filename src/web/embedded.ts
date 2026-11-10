// Panel assets for a compiled release. This committed placeholder stays undefined.
// `bun run build:panel` (scripts/build-panel.ts) overwrites it with the built
// panel before `bun build --compile`. A source checkout never needs it: serve
// builds the panel from web/ at run time.
export type EmbeddedPanel = { html: string; css: string; script: string };
export const embeddedPanel: EmbeddedPanel | undefined = undefined;
