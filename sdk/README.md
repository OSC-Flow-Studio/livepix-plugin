# Bundled SDK

`ofs-package.mjs` and `community-plugin-manifest.schema.json` are unmodified copies
from the OSC Flow Studio **0.5.4** source SDK, including native date fields. They
validate and package the plugin and are excluded from its installed ZIP.

When updating the SDK, replace both files, review the runtime contract, update
`engines.oscFlowStudio`, and run `npm run check`.
