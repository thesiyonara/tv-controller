/**
 * electron-builder configuration (JS so signing/notarization can depend on the environment).
 *
 * Unsigned builds (default): macOS bundles are ad-hoc signed by scripts/afterPack.js so they
 * open via System Settings → Privacy & Security → Open Anyway.
 * Signed builds: set CSC_LINK (base64 .p12) + CSC_KEY_PASSWORD, and for notarization
 * APPLE_ID + APPLE_APP_SPECIFIC_PASSWORD + APPLE_TEAM_ID. Then no dialog appears at all.
 */
const notarize = Boolean(process.env.APPLE_ID && process.env.APPLE_APP_SPECIFIC_PASSWORD && process.env.APPLE_TEAM_ID);

module.exports = {
  appId: 'dev.thesiyonara.androidtvcontroller',
  productName: 'TV Controller',
  artifactName: '${productName}-${version}-${os}-${arch}.${ext}',
  files: ['dist/**/*', 'assets/**/*', 'package.json'],
  directories: { buildResources: 'build', output: 'release' },
  afterPack: 'scripts/afterPack.js',
  mac: {
    category: 'public.app-category.utilities',
    target: [
      { target: 'dmg', arch: ['arm64', 'x64'] },
      { target: 'zip', arch: ['arm64', 'x64'] },
    ],
    darkModeSupport: true,
    hardenedRuntime: true,
    gatekeeperAssess: false,
    entitlements: 'build/entitlements.mac.plist',
    entitlementsInherit: 'build/entitlements.mac.plist',
    notarize,
    extendInfo: {
      NSLocalNetworkUsageDescription: 'TV Controller finds and talks to TVs and streaming boxes on your local network.',
      NSBonjourServices: ['_androidtvremote2._tcp', '_googlecast._tcp', '_roku._tcp'],
    },
  },
  win: {
    target: [
      { target: 'nsis', arch: ['x64'] },
      { target: 'portable', arch: ['x64'] },
    ],
  },
  nsis: { oneClick: false, allowToChangeInstallationDirectory: true, createDesktopShortcut: true, runAfterFinish: true },
  portable: { artifactName: '${productName}-${version}-${os}-${arch}-portable.${ext}' },
  linux: { target: ['AppImage', 'deb'], category: 'Utility', icon: 'build/icon.png' },
  publish: [{ provider: 'github', owner: 'thesiyonara', repo: 'tv-controller' }],
};
