"use strict";
// Mechanical packaging: keep all three extensions on the same tested autofill code.
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
for (const project of ['linkedin','jobstreet','careersgov']) {
  for (const file of fs.readdirSync(path.join(root, 'shared_tracker/extension'))) {
    if (!/\.(js|html|css)$/.test(file)) continue;
    fs.copyFileSync(path.join(root,'shared_tracker/extension',file), path.join(root,project,'extension',file));
  }
}
console.log('Shared Workday/SuccessFactors assets synchronized to all three extensions.');
