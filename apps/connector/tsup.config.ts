import { defineConfig } from 'tsup';

export default defineConfig({
  entry              : ['src/index.ts'],
  format             : ['esm'],
  target             : 'node24',
  outDir             : 'dist',
  clean              : true,
  // Node's sqlite module exists only under its `node:` prefix.
  removeNodeProtocol : false,
  banner             : {
    js: "import { createRequire as __dashupCreateRequire } from 'node:module'; const require = __dashupCreateRequire(import.meta.url);",
  },
  // Workspace code ships inside the bundle; npm installs only real registry packages.
  noExternal         : [/^@dashup\//, /^@parcae\//],
  // debug's optional colour support resolves only where pnpm hoists it, so it stays out and the
  // monorepo and the public mirror build the same bytes.
  external           : ['supports-color'],
});
