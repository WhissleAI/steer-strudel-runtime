# Steer's Strudel runtime: Corresponding Source

This is the complete Corresponding Source of the Strudel runtime that ships inside **Steer for Mac 1.7.0** (build 55,
`Steer.app/Contents/Resources/strudel/`) and **Steer for Android 1.17.0** (versionCode 55, `assets/strudel/`). It is the
music engine of Steer's Music studio. It is licensed under the **GNU Affero General Public License v3.0 or later**
(`LICENSE`), the licence of Strudel itself.

The rest of Steer is a separate program. It loads this bundle into a web view and talks to it through the bridge in
`tools/strudel/steer_host.mjs`. The bridge and the visuals glue (`viz.mjs`, `scene3d.mjs`) are bundled into the same
files, so they are published here under the AGPL as well.

## What's here

| Path | What it is |
|---|---|
| `tools/build_strudel.sh` | The build script. It runs `npm ci` and then esbuild, and writes `Resources/strudel/strudel.js`, `scene.js` and `NOTICE.txt` |
| `tools/strudel/package.json`, `package-lock.json` | The pinned dependencies: `@strudel/core`, `draw`, `mini`, `tonal` and `transpiler` 1.2.6, `@strudel/webaudio` 1.3.0, `superdough` 1.3.0, `three` 0.186.1 and `esbuild` 0.25.10 |
| `tools/strudel/steer_host.mjs` | Steer's bridge: the API the app calls (play, stop, evaluate, the meters) and the entry point of `strudel.js` |
| `tools/strudel/viz.mjs` | The pattern views and palettes (built on `@strudel/draw`), bundled into `strudel.js` |
| `tools/strudel/scene3d.mjs` | The Scene layer (three.js, MIT), the entry point of `scene.js` |
| `index.html` | The page the web view loads |
| `NOTICE.txt` | Every bundled package with its version and licence, as shipped |
| `android/steer_palette.py` | The Android build's one change to `strudel.js`: it adds the "steer" palette to the palette table |
| `android/copyStrudel.gradle.txt` | The Gradle task that makes that change in the Android build, quoted from `android/app/build.gradle` |
| `LICENSE` | The GNU AGPL v3 |

## Rebuilding the exact files

You need Node.js (tested with v26.13) and network access for `npm ci`. The app itself never fetches anything.

```sh
bash tools/build_strudel.sh          # writes Resources/strudel/strudel.js, scene.js and NOTICE.txt
shasum -a 256 Resources/strudel/strudel.js Resources/strudel/scene.js
```

Expected output:

```
106232e4ea207cc3396ad07c6ba9870dbf0114a9c341a3736e649f98f874b0ae  Resources/strudel/strudel.js   (752,984 bytes; Mac 1.7.0)
f2242dc5a3f6338b41f19ac1f5381bac5c4edbb2bccbdf8e9831e3d763eba530  Resources/strudel/scene.js     (930,720 bytes; both apps)
```

To get the Android 1.17.0 `assets/strudel/strudel.js`, apply the palette change:

```sh
python3 android/steer_palette.py Resources/strudel/strudel.js android-strudel.js
shasum -a 256 android-strudel.js
```

Expected output:

```
4b99331e4385984329485e33711bbc7088a49fb4d8f9d9dad95506a4a11d650d  android-strudel.js   (753,052 bytes; Android 1.17.0 assets/strudel/strudel.js)
```

To check against an installed copy, compare with `Steer.app/Contents/Resources/strudel/strudel.js` on a Mac, or unzip
`assets/strudel/strudel.js` from `Steer-1.17.0.apk`.

## Upstream

Strudel: https://codeberg.org/uzu/strudel (© the Strudel contributors, AGPL-3.0-or-later). Kabelsalat
(`@kabelsalat/*`, pulled in by `superdough`): AGPL-3.0-or-later. three.js: https://github.com/mrdoob/three.js (MIT).
