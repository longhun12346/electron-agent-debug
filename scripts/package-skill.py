"""Create a reproducible release ZIP using only the Python standard library."""
import sys
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile, ZipInfo

root = Path(__file__).resolve().parent.parent / "skill" / "electron-debug"
if len(sys.argv) != 2:
    raise SystemExit("usage: package-skill.py <output.zip>")
destination = Path(sys.argv[1]).resolve()
if destination.is_relative_to(root):
    raise SystemExit("release archive must be outside the Skill directory")
destination.parent.mkdir(parents=True, exist_ok=True)
with ZipFile(destination, "w", compression=ZIP_DEFLATED, compresslevel=9) as archive:
    for source in sorted(root.rglob("*")):
        if source.is_symlink():
            raise SystemExit(f"symlink not allowed in release package: {source.name}")
        if not source.is_file():
            continue
        name = "electron-debug/" + source.relative_to(root).as_posix()
        info = ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
        info.create_system = 3
        info.compress_type = ZIP_DEFLATED
        info.external_attr = 0o100644 << 16
        archive.writestr(info, source.read_bytes(), compresslevel=9)
print(destination)
