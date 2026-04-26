import { writeFileSync } from "fs";

// CJS consumers need a local package.json override so Node treats .js files
// in dist/cjs/ as CommonJS despite the root "type": "module".
writeFileSync(
  new URL("../dist/cjs/package.json", import.meta.url),
  '{"type":"commonjs"}\n',
);
