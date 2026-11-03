# Security model

The app talks only to devices on your LAN, plus three anonymous HTTPS endpoints
(GitHub Releases for updates, the public Play Store page for Android app icons,
YouTube's public results page for search). There are no accounts and nothing is
uploaded anywhere.

## Transport to each device

| Device | Transport | Server identity | Client identity |
|---|---|---|---|
| Android TV / Google TV | TLS 1.2+ on 6466/6467 | **Pinned.** The TV's certificate is self-signed, so it can't be validated by a CA; its SHA‑256 fingerprint is recorded at pairing and every later session must present the same one. A different certificate (factory reset, or something between you and the TV) aborts the connection and requires pairing again. The pairing secret itself hashes both certificates' public keys, so a man-in-the-middle during pairing can't produce a code the TV accepts. | Our self-signed client certificate (2048-bit RSA), generated on this machine; the private key never leaves it. |
| Google Cast | TLS on 8009 | Self-signed; not validated (the protocol has no pairing). Cast lets anyone on the LAN control playback and volume by design. | none |
| Samsung Tizen | WSS on 8002 (+ UPnP over HTTP on 9197 for volume) | Self-signed; not validated. | Token issued by the TV after you press *Allow*. |
| LG webOS | WSS on 3001 | Self-signed; not validated. | Client key issued by the TV after you press *Allow*. |
| Roku | plain HTTP on 8060 (ECP) | none (protocol has no auth) | none |

The non-Android protocols offer no way to verify the TV's certificate; what protects
them is that the attacker has to be on your LAN already. Keep TVs off guest networks
and don't expose these ports through the router.

## What leaves your computer

| Connection | When | Switch |
|---|---|---|
| `api.github.com` / `github.com` release files | update check at launch and every 6 h; downloading an update | *Check for updates automatically*, or *Local network only* |
| `play.google.com`, `www.google.com/s2/favicons` | fetching an Android app's icon (cached 30 days) | *Official app icons*, or *Local network only* |
| `www.youtube.com` results page | only when you search in the YouTube tab | *Local network only* (search then opens on the TV instead) |
| `dl.google.com` platform-tools | only when you click Download in the install panel | *Local network only* |
| Artwork / icon URLs reported by the TV (e.g. `i.ytimg.com`) | now-playing artwork, Roku/LG app icons | *Local network only* blocks any non-private address |

With **Local network only** on, the app makes no internet connections at all; it also refuses to load anything in its window that isn't a private LAN address.

## Credentials at rest

Pairing certificates, Samsung tokens and LG client keys are stored in the app's data file with mode `0600` (readable only by your user account). Optionally (*Keep pairings in the system keychain*) they are encrypted with Electron's `safeStorage`: DPAPI on Windows (default on, no prompt), Keychain on macOS (default off, because an ad‑hoc signed app is asked for keychain access again after every update), libsecret/kwallet on Linux.

## Electron hardening

- Renderer runs sandboxed with context isolation; no Node integration.
- A strict Content‑Security‑Policy; images may load from the LAN and HTTPS (TV icons, artwork).
- The preload exposes only the typed `window.controller` functions; every call is validated in the main process.
- All navigation and `<webview>` attachment is blocked; external links open in the system browser and only `http(s)` is allowed (plus the macOS Local Network settings URL).
- Every permission request (camera, microphone, location, notifications…) is denied.
- Single-instance lock; the window hides to the tray rather than relaunching.

## What a misbehaving TV can do

A TV (or anything on the LAN pretending to be one) talks to the app over the protocols above, so its messages are treated as untrusted input:

- Android TV remote frames are capped at 1 MB; a length prefix beyond that drops the connection instead of buffering towards it. The TV's text, app and volume fields are copied as data and rendered as text, never as markup.
- Samsung and LG JSON frames that aren't objects (`null`, a bare string) are ignored; subscription payloads are type-checked field by field before they reach the UI.
- Roku XML and `dumpsys` output are parsed with anchored expressions; unknown values show up as text or not at all.
- Device names, app names, titles and feed lines are escaped before they reach the DOM. The stress suites push script tags, event handlers, direction-override characters and kilobyte-long words through every one of these paths (`npm run stress`, `npm run stress:ui`).
- The settings file is the app's own, but it is checked for shape on every read so a damaged or hand-edited file can't crash the app at launch; valid entries are kept and the rest fall back to defaults.

## Updates

Release metadata comes from GitHub over HTTPS; electron‑updater verifies the
SHA‑512 of each download against `latest.yml`. The builds are not code‑signed,
so the OS can't attest the publisher: on first install macOS and Windows will
ask you to confirm. Signing requires an Apple Developer / Windows code‑signing
certificate; the CI workflow already supports `CSC_LINK` secrets.

## Updates on macOS

The app downloads the release zip for your chip from GitHub over TLS, unpacks it under its own data
folder, checks that the bundle identifier is this app's, and only then replaces the running copy
(after you choose "Restart to update") with a short shell script that waits for the app to quit.
There is no code-signature check beyond TLS, same as a manual download. The app never replaces
itself while running from a dmg or from a folder it cannot write; it opens the dmg download instead.

## ADB (installing apps)

Sideloading uses Google's `adb`, downloaded from `dl.google.com` only after you accept the SDK
terms in the app, or an `adb` already on your PATH. ADB access is powerful (it can install,
uninstall and read the screen), which is why it needs Developer options turned on and an explicit
"Allow debugging from this computer" on the TV. The RSA key that identifies this computer to the
TV is adb's own (`~/.android/adbkey`). The app only ever points adb at the Android TV behind the
device you chose, and only runs: `connect`, `devices`, `install -r`, `uninstall`, `shell cmd package
query-activities`, `shell monkey -p … 1`, `shell dumpsys media_session`, `exec-out screencap -p`,
`kill-server`.

The live view polls `dumpsys media_session` (what the TV is playing) every few seconds and, only
when you turn the screen option on, takes a screenshot every few seconds. Frames are downscaled in
the app, kept in memory only, never written to disk, and not captured while the window is hidden.
Turning screen preview off leaves playback reporting running. Stopping playback reporting explicitly (or quitting the app) stops its poll.

## What the app never does

- Root a TV or install apps without an explicit user request. Optional ADB installation requires the TV’s authorization.
- Send your clipboard anywhere except the TV you explicitly target.
- Log tokens, certificates or typed text. The log file has discovery activity and error messages only.

### Storage choices

With encryption off and no pre-existing encrypted pairings, the store does not call the OS keychain. The local file is not encrypted; software running as your account can read it. Existing encrypted pairings need OS access to read or migrate. If access is declined, the encrypted payload is preserved. No PIN-based encryption is claimed or implemented.
