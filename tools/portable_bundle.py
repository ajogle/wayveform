"""Assemble a portable Electron bundle from Bazel-declared inputs."""

import json
import os
from pathlib import Path, PurePosixPath
import plistlib
import shutil
import stat
import sys
import tempfile
import zipfile


def extract_runtime(archive: Path, destination: Path) -> None:
    with zipfile.ZipFile(archive) as source:
        for entry in source.infolist():
            relative = PurePosixPath(entry.filename)
            if relative.is_absolute() or ".." in relative.parts:
                raise ValueError(f"unsafe Electron archive entry: {entry.filename}")
            target = destination.joinpath(*relative.parts)
            mode = entry.external_attr >> 16
            if entry.is_dir():
                target.mkdir(parents=True, exist_ok=True)
            elif stat.S_ISLNK(mode):
                target.parent.mkdir(parents=True, exist_ok=True)
                target.symlink_to(source.read(entry).decode())
            else:
                target.parent.mkdir(parents=True, exist_ok=True)
                with source.open(entry) as stream, target.open("wb") as output:
                    shutil.copyfileobj(stream, output)
                if mode:
                    target.chmod(stat.S_IMODE(mode))


def stage_packages(inputs: list[Path], destination: Path, addon: Path, os_name: str, arch: str) -> None:
    packages: dict[str, tuple[str, Path]] = {}
    marker = "/node_modules/.aspect_rules_js/"
    for path in inputs:
        if marker not in str(path) or not path.is_dir():
            continue
        manifest = path / "package.json"
        if not manifest.is_file():
            continue
        metadata = json.loads(manifest.read_text())
        name = metadata.get("name")
        version = metadata.get("version")
        if not isinstance(name, str) or not isinstance(version, str):
            continue
        previous = packages.get(name)
        if previous and previous[0] != version:
            raise ValueError(f"multiple runtime versions of {name}: {previous[0]} and {version}")
        packages[name] = (version, path)

    required = {"better-sqlite3", "music-metadata", "yauzl"}
    missing = required - packages.keys()
    if missing:
        raise ValueError(f"missing runtime packages: {', '.join(sorted(missing))}")

    for name, (_, source) in sorted(packages.items()):
        target = destination.joinpath(*name.split("/"))
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copytree(source, target, symlinks=False)

    sqlite_prebuilds = destination / "better-sqlite3" / "prebuilds"
    for prebuild in sqlite_prebuilds.glob("*.node"):
        prebuild.unlink()
    platform_name = {"linux": "linux", "macos": "darwin", "windows": "win32"}[os_name]
    shutil.copyfile(addon, sqlite_prebuilds / f"{platform_name}-{arch}.node")


def write_archive(source: Path, output: Path) -> None:
    with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=6, allowZip64=True) as archive:
        for path in sorted(source.rglob("*")):
            relative = path.relative_to(source).as_posix()
            mode = path.lstat().st_mode
            if path.is_dir() and not path.is_symlink():
                continue
            info = zipfile.ZipInfo(relative, date_time=(1980, 1, 1, 0, 0, 0))
            info.create_system = 3
            info.external_attr = mode << 16
            info.compress_type = zipfile.ZIP_DEFLATED
            if path.is_symlink():
                archive.writestr(info, os.readlink(path).encode())
            else:
                with path.open("rb") as stream, archive.open(info, "w", force_zip64=True) as writer:
                    shutil.copyfileobj(stream, writer)


def main() -> None:
    output = Path(sys.argv[1])
    inputs = Path(sys.argv[2])
    os_name = sys.argv[3]
    arch = sys.argv[4]
    modules = [Path(arg) for arg in sys.argv[5:]]
    if os_name not in {"linux", "macos", "windows"} or arch not in {"x64", "arm64"}:
        raise ValueError(f"unsupported target: {os_name}-{arch}")

    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(dir=output.parent) as temporary:
        root = Path(temporary)
        bundle = root / ("Wayveform.app" if os_name == "macos" else "Wayveform")
        if os_name == "macos":
            extract_runtime(inputs / "runtime" / "electron.zip", root)
            (root / "Electron.app").rename(bundle)
        else:
            bundle.mkdir()
            extract_runtime(inputs / "runtime" / "electron.zip", bundle)

        if os_name == "macos":
            resources = bundle / "Contents" / "Resources"
            plist = bundle / "Contents" / "Info.plist"
            if plist.exists():
                with plist.open("rb") as stream:
                    properties = plistlib.load(stream)
                properties["CFBundleName"] = "Wayveform"
                properties["CFBundleDisplayName"] = "Wayveform"
                properties["CFBundleIdentifier"] = "org.wayveform.desktop"
                with plist.open("wb") as stream:
                    plistlib.dump(properties, stream)
        else:
            resources = bundle / "resources"
            executable = bundle / ("electron.exe" if os_name == "windows" else "electron")
            if executable.exists():
                executable.rename(bundle / ("Wayveform.exe" if os_name == "windows" else "wayveform"))

        app = resources / "app"
        app.mkdir(parents=True)
        shutil.copy2(inputs / "app" / "package.json", app / "package.json")
        shutil.copy2(inputs / "app" / "LICENSE", app / "LICENSE")
        shutil.copytree(inputs / "app" / "dist", app / "dist")
        stage_packages(modules, app / "node_modules", inputs / "native" / "better_sqlite3.node", os_name, arch)
        write_archive(root, output)


if __name__ == "__main__":
    main()
