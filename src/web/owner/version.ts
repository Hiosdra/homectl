// The version of the homectl build that serves this panel. The broker reports no
// version over its owner routes, so this is the panel's own build, not a
// broker-reported value. The bundler inlines it.
import pkg from "../../../package.json" with { type: "json" };

export const PANEL_VERSION: string = pkg.version;
