// electron-builder afterPack hook.
//
// macOS: when no Developer ID is configured, ad-hoc sign the whole bundle. An app with
// no signature at all is reported by Gatekeeper as "damaged" on Apple Silicon and cannot
// be opened; an ad-hoc signed one gets the standard "Apple could not verify…" dialog
// with an "Open Anyway" button under System Settings → Privacy & Security. A real
// Developer ID (CSC_LINK in CI) is signed by electron-builder itself and this hook does nothing.
const { execFileSync } = require('child_process');
const path = require('path');

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;
  if (process.env.CSC_LINK || process.env.CSC_NAME) return; // real signing handled by electron-builder
  const appName = context.packager.appInfo.productFilename;
  const appPath = path.join(context.appOutDir, `${appName}.app`);
  console.log(`  • ad-hoc signing ${appPath} (no Developer ID configured)`);
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', '--timestamp=none', appPath], { stdio: 'inherit' });
  execFileSync('codesign', ['--verify', '--deep', '--strict', '--verbose=1', appPath], { stdio: 'inherit' });
};
