"""Check that a portable release contains the selected runtime and native addon."""

import argparse
from pathlib import Path
import plistlib
import re
import zipfile


PATTERN = re.compile(r"Wayveform-\d+\.\d+\.\d+-(linux|macos|windows)-(x64|arm64)-portable\.zip$")
MAGIC = {
    "linux": b"\x7fELF",
    "macos": (b"\xcf\xfa\xed\xfe", b"\xca\xfe\xba\xbe", b"\xbe\xba\xfe\xca"),
    "windows": b"MZ",
}
SQLITE_PLATFORM = {"linux": "linux", "macos": "darwin", "windows": "win32"}


def verify(path: Path) -> None:
    match = PATTERN.fullmatch(path.name)
    if not match:
        raise ValueError(f"unrecognized portable archive name: {path.name}")
    os_name, arch = match.groups()
    if os_name == "macos":
        root = "Wayveform.app/Contents/"
        app = root + "Resources/app/"
        executable = root + "MacOS/Electron"
    else:
        root = "Wayveform/"
        app = root + "resources/app/"
        executable = root + ("Wayveform.exe" if os_name == "windows" else "wayveform")
    addon = app + f"node_modules/better-sqlite3/prebuilds/{SQLITE_PLATFORM[os_name]}-{arch}.node"

    with zipfile.ZipFile(path) as archive:
        names = set(archive.namelist())
        required = {
            executable,
            addon,
            app + "package.json",
            app + "LICENSE",
            app + "dist/electron/main.js",
            app + "dist/electron/worker.js",
            app + "dist/renderer/index.html",
            app + "node_modules/music-metadata/package.json",
            app + "node_modules/yauzl/package.json",
        }
        missing = required - names
        if missing:
            raise ValueError(f"{path.name} is missing {sorted(missing)}")
        prebuilds = [name for name in names if name.startswith(app + "node_modules/better-sqlite3/prebuilds/") and name.endswith(".node")]
        if prebuilds != [addon]:
            raise ValueError(f"{path.name} has incorrect SQLite prebuilds: {prebuilds}")
        expected = MAGIC[os_name]
        for binary in (executable, addon):
            with archive.open(binary) as stream:
                header = stream.read(4)
            if isinstance(expected, tuple):
                valid = header in expected
            else:
                valid = header.startswith(expected)
            if not valid:
                raise ValueError(f"{binary} has the wrong binary format")
        if os_name == "macos":
            properties = plistlib.loads(archive.read(root + "Info.plist"))
            if properties.get("CFBundleIdentifier") != "org.wayveform.desktop":
                raise ValueError(f"{path.name} has the wrong bundle identifier")
        bad_member = archive.testzip()
        if bad_member:
            raise ValueError(f"{path.name} has a corrupt member: {bad_member}")
    print(f"verified {path.name}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("archives", nargs="+", type=Path)
    arguments = parser.parse_args()
    for archive_path in arguments.archives:
        verify(archive_path)
