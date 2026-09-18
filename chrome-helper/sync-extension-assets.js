"use strict";
// Mechanical packaging: copy the shared autofill source into the one loadable extension.
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const destination = path.join(root, 'extension');
fs.mkdirSync(destination, {recursive: true});
for (const file of fs.readdirSync(path.join(root, 'shared_tracker/extension'))) {
  if (!/\.(js|html|css)$/.test(file)) continue;
  fs.copyFileSync(path.join(root,'shared_tracker/extension',file), path.join(destination,file));
}
console.log('Shared Workday/SuccessFactors assets synchronized to the unified extension.');
