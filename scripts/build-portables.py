"""Build every unsigned portable desktop archive with Bazel."""

import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys


ROOT = Path(__file__).resolve().parents[1]
VERSION = json.loads((ROOT / "package.json").read_text())["version"]
TARGETS = (
    ("linux_x64", "linux-x64"),
    ("linux_arm64", "linux-arm64"),
    ("macos_x64", "macos-x64"),
    ("macos_arm64", "macos-arm64"),
    ("windows_x64", "windows-x64"),
    ("windows_arm64", "windows-arm64"),
)


def main() -> None:
    bazelisk = ROOT / "node_modules" / ".bin" / ("bazelisk.cmd" if sys.platform == "win32" else "bazelisk")
    if not bazelisk.exists():
        raise SystemExit("Install dependencies with npm ci before building portable archives")
    release = ROOT / "release"
    release.mkdir(exist_ok=True)
    output_root = os.environ.get("WAYVEFORM_BAZEL_OUTPUT_ROOT")
    startup_args = [f"--output_user_root={output_root}"] if output_root else []

    for config, filename_part in TARGETS:
        subprocess.run([str(bazelisk), *startup_args, "build", f"--config={config}", "//:portable_bundle"], cwd=ROOT, check=True)
        source = ROOT / "bazel-bin" / "portable_bundle.zip"
        destination = release / f"Wayveform-{VERSION}-{filename_part}-portable.zip"
        destination.unlink(missing_ok=True)
        shutil.copyfile(source, destination)
        print(f"created {destination.name}", flush=True)

    archives = sorted(release.glob(f"Wayveform-{VERSION}-*-portable.zip"))
    subprocess.run([sys.executable, str(ROOT / "scripts" / "verify-portable.py"), *map(str, archives)], cwd=ROOT, check=True)
    artifacts = archives + sorted(release.glob("*.AppImage"))
    checksums = []
    for artifact in artifacts:
        hasher = hashlib.sha256()
        with artifact.open("rb") as stream:
            for chunk in iter(lambda: stream.read(1024 * 1024), b""):
                hasher.update(chunk)
        digest = hasher.hexdigest()
        checksums.append(f"{digest}  release/{artifact.name}")
    (release / "SHA256SUMS.txt").write_text("\n".join(checksums) + "\n")
    print("updated SHA256SUMS.txt")


if __name__ == "__main__":
    main()
