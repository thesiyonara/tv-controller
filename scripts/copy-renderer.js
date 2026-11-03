// Copies static files (renderer HTML/CSS/JS and the protocol schema) into dist/.
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
function copyDir(from, to, filter) {
  fs.mkdirSync(to, { recursive: true });
  for (const f of fs.readdirSync(from)) {
    if (filter && !filter(f)) continue;
    const src = path.join(from, f);
    if (fs.statSync(src).isDirectory()) copyDir(src, path.join(to, f), filter);
    else fs.copyFileSync(src, path.join(to, f));
  }
}
copyDir(path.join(root, 'src/renderer'), path.join(root, 'dist/renderer'));
copyDir(path.join(root, 'src/main/remote'), path.join(root, 'dist/main/remote'), (f) => f.endsWith('.proto'));
console.log('static files copied');

// Shared pure playback selection runs in both the main process and browser renderer.
fs.mkdirSync(path.join(root, "dist/shared"), { recursive: true });
for (const folder of ["shared", "renderer"]) fs.copyFileSync(path.join(root, "src/shared/media-selection.js"), path.join(root, "dist", folder, "media-selection.js"));
