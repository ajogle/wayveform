# Wayveform

Wayveform is a local desktop app for turning a list of songs into a library of music files you can keep. Import a CSV, JSON, or Spotify account-data ZIP; review possible recordings and store links; then connect audio files you already own and export a playable playlist. Your inventory lives in a local SQLite database. Wayveform does not connect to your Spotify account or buy or download tracks for you.

This is an early prototype. The installation notes and current limits below describe what has been verified and what remains before a public release.

## Install a portable build

Unsigned portable archives for Linux, macOS, and Windows on x64 and arm64 can be distributed separately. The build script puts them in `release/`, which is not included in a source checkout. If you have a binary archive, choose the one matching your operating system and processor, then extract it. The archives include Electron and the app's SQLite dependency; Node, npm, and Bazel are not needed to run them.

| System | Archive name | Launch after extraction |
| --- | --- | --- |
| Linux x64 or arm64 | `Wayveform-0.1.0-linux-<arch>-portable.zip` | `Wayveform/wayveform` |
| Windows x64 or arm64 | `Wayveform-0.1.0-windows-<arch>-portable.zip` | `Wayveform/Wayveform.exe` |
| macOS Intel or Apple silicon | `Wayveform-0.1.0-macos-<arch>-portable.zip` | `Wayveform.app` |

Here, `<arch>` is `x64` or `arm64`. Extract the whole archive before launching the app. If you have the unsigned Linux x64 `Wayveform-0.1.0.AppImage`, make it executable and launch it:

```sh
chmod +x release/Wayveform-0.1.0.AppImage
./release/Wayveform-0.1.0.AppImage
```

The portable ZIPs are application folders, not installers. They are unsigned, and the macOS builds are not notarized. Only the Linux x64 portable build and AppImage have been launched in this development environment. Other platforms still need testing on their target systems before they should be treated as release-ready.

## Build from source with Bazel

You need Node.js 22, npm, and Python 3. Bazelisk is installed with the project dependencies and downloads the Bazel version pinned in `.bazelversion` on first use. From the project root:

```sh
npm ci
npx bazelisk test //:unit_tests
npx bazelisk build --config=linux_x64 //:portable_bundle
```

The last command produces `bazel-bin/portable_bundle.zip`. Replace `linux_x64` with one of `linux_arm64`, `macos_x64`, `macos_arm64`, `windows_x64`, or `windows_arm64` for another target. Bazel builds the JavaScript on the host and selects a checksum-pinned Electron runtime and matching SQLite native addon for the target. These portable bundles can be assembled on a Linux x64 host; building them does not establish that they run correctly on every target system.

To build all six portable archives, verify their contents, and write `release/SHA256SUMS.txt`:

```sh
python3 scripts/build-portables.py
```

For a quick code build without packaging, use `npx bazelisk build //:app_js`. The Bazel definitions are in `BUILD.bazel`, the platform configurations in `.bazelrc`, and JavaScript dependencies for Bazel in `pnpm-lock.yaml`. The renderer build currently runs locally because Vite follows sandbox symlinks outside Bazel's sandbox; the TypeScript, test, and packaging actions remain sandboxed.

## Use Wayveform

1. **Import a music list.** Select **Import music list** and choose a CSV, JSON, or Spotify account-data ZIP. For CSV, review the detected columns and map artist and title before importing. The import report shows accepted and rejected rows.
2. **Review your inventory.** Browse tracks, choose an import or collection, and keep repeated playlist entries in their original order. You can export the inventory as CSV or JSON at any time.
3. **Find recordings you want to buy.** Search an individual track in Apple's US catalog or select **Find missing tracks** to queue searches. Review and accept a candidate recording before opening its store page. **Build plan** compares accepted price observations for recordings still missing a linked file.
4. **Buy and download outside the app.** Complete any purchase in your browser. **I purchased this** records your confirmation; it does not verify payment or mean that Wayveform has an audio file.
5. **Add your audio.** Select **Scan a music folder** or **Import audio ZIP**. Review suggested file links, or find an inventory track and link it manually. Wayveform reads tags and hashes files, but you decide which recordings match.
6. **Organize and export.** **Copy linked files to library** creates an artist/album folder structure while keeping the originals. **Export M3U8** writes a playlist with relative file paths; unlinked or unavailable files are reported and omitted. You can also export a selected import or collection.

Use **Back up library** before major changes. **Restore backup** validates a saved database, keeps a safety copy of the previous database, and restarts the app. Backups contain the inventory database, not your audio files. Deleting an import removes its tracks and related decisions from that database but leaves audio files and saved backups in place.

### Import formats

- **CSV:** Artist and title are required. Headers such as `Artist` or `Artist Name`, `Title` or `Track Name`, and optional album, duration in milliseconds, ISRC, and collection columns are recognized; other headers can be mapped in the app.
- **JSON:** An array of tracks, or an object with a `tracks` or `items` array. Each row needs an artist and title.
- **Spotify account-data ZIP:** The importer reads `YourLibrary.json` and `Playlist*.json` from the ZIP. It does not need listening history or payment records. Request an account-data export from Spotify, then select the ZIP once it arrives. This importer has been tested with synthetic fixtures but not yet with a current real account export.

Wayveform does not need an app account or provider credentials. Your inventory database is stored in Electron's per-user application data folder. Files and exports go to the locations you choose. Catalog searches send track artist and title to Apple; importing and organizing local files work without a catalog connection.

## Development

For a local development run, install dependencies and prepare the native SQLite addon for Electron:

```sh
npm ci
npx electron-builder install-app-deps
npm start
```

Run `npm run typecheck` for both TypeScript projects and `npx bazelisk test //:unit_tests` for unit tests. The app uses Electron, React, TypeScript, and SQLite. The renderer communicates with the main process through a narrow preload bridge; database and import work runs in a worker.

## Current limits

Apple catalog prices are observed US store prices, not verified offers for a particular download format. The buying plan compares reviewed observations; it cannot guarantee the cheapest way to acquire every track. Store checkout and downloads happen outside Wayveform, and confirming a purchase is separate from linking an audio file. Audio metadata and hashes do not prove purchase or file integrity. Direct Spotify login, automatic checkout, signed installers, notarization, and target-system testing remain outside this prototype.

## License

Wayveform is licensed under the [MIT License](LICENSE).
