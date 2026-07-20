#!/usr/bin/env python3
"""Capture, verify, back up, and restore target-specific BOS visuals.

The visual baseline belongs to the installed BOS, not to a release. Assets are
protected byte-for-byte. UI source files are discovered when they contain
avatar, picker, portrait, scene, or image bindings; only the matching visual
lines are fingerprinted so unrelated functional changes can still ship.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path


ASSET_ROOTS = (
    Path("apps/web/src/assets"),
    Path("apps/web/public"),
    Path("public"),
)
PROTECTED_EXTENSIONS = {
    ".png",
    ".jpg",
    ".jpeg",
    ".webp",
    ".avif",
    ".svg",
    ".gif",
}
SOURCE_ROOTS = (
    Path("apps/web/src"),
    Path("apps/web/app"),
    Path("apps/web/components"),
    Path("apps/web/pages"),
)
SOURCE_EXTENSIONS = {".ts", ".tsx", ".js", ".jsx", ".css", ".scss", ".sass", ".less"}
FIXED_SURFACES = (
    Path("apps/web/src/components/Layout.tsx"),
    Path("apps/web/src/components/AgentAvatar.tsx"),
    Path("apps/web/src/components/AvatarPicker.tsx"),
    Path("apps/web/src/pages/AgentWorkspace.tsx"),
    Path("apps/web/src/pages/Builder.tsx"),
    Path("apps/web/src/pages/Office.tsx"),
    Path("apps/web/src/pages/Rascals.tsx"),
    Path("apps/web/src/pages/Outsiders.tsx"),
)
IMAGE_EXTENSION_PATTERN = r"\.(?:png|jpe?g|webp|avif|svg|gif)"
VISUAL_LINE = re.compile(
    rf"(?:{IMAGE_EXTENSION_PATTERN}|avatar|portrait|(?:avatar|image)[-_ ]?picker|"
    r"office[-_ ]scene|bullpen|boardroom|desk[-_ ]scene|background(?:image)?|"
    r"boss_agent_avatar|boss_office_avatar)",
    re.IGNORECASE,
)
DISCOVERY_MARKER = re.compile(
    rf"(?:{IMAGE_EXTENSION_PATTERN}|avatar|portrait|(?:avatar|image)[-_ ]?picker|"
    r"office[-_ ]scene|bullpen|boardroom|desk[-_ ]scene|"
    r"boss_agent_avatar|boss_office_avatar)",
    re.IGNORECASE,
)
BACKUP_METADATA = "backup-metadata.json"
BACKUP_MANIFEST = "visual-baseline.json"


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def is_within(path: Path, parent: Path) -> bool:
    try:
        path.relative_to(parent)
        return True
    except ValueError:
        return False


def safe_repo_path(root: Path, relative: str | Path) -> Path:
    rel_path = Path(relative)
    if rel_path.is_absolute() or not rel_path.parts or ".." in rel_path.parts:
        raise RuntimeError(f"unsafe repository-relative path: {relative}")
    candidate = root / rel_path
    resolved_root = root.resolve(strict=False)
    resolved_candidate = candidate.resolve(strict=False)
    if not is_within(resolved_candidate, resolved_root):
        raise RuntimeError(f"path escapes repository root: {relative}")
    return candidate


def normalize_visual_lines(path: Path) -> list[str]:
    """Return normalized visual bindings in their original source order."""

    text = path.read_text(encoding="utf-8")
    lines: list[str] = []
    for line in text.splitlines():
        if VISUAL_LINE.search(line):
            normalized = " ".join(line.strip().split())
            if normalized:
                lines.append(normalized)
    return lines


def discover_surfaces(root: Path) -> list[Path]:
    surfaces: set[Path] = set()

    for rel_path in FIXED_SURFACES:
        if safe_repo_path(root, rel_path).is_file():
            surfaces.add(rel_path)

    for source_root in SOURCE_ROOTS:
        source_dir = safe_repo_path(root, source_root)
        if not source_dir.is_dir():
            continue
        for path in sorted(source_dir.rglob("*")):
            if not path.is_file() or path.suffix.lower() not in SOURCE_EXTENSIONS:
                continue
            if path.is_symlink():
                raise RuntimeError(f"visual source must not be a symlink: {path}")
            rel_path = path.relative_to(root)
            text = path.read_text(encoding="utf-8")
            if DISCOVERY_MARKER.search(rel_path.name) or DISCOVERY_MARKER.search(text):
                surfaces.add(rel_path)

    return sorted(surfaces, key=lambda path: path.as_posix())


def collect(root: Path) -> dict[str, object]:
    assets: dict[str, str] = {}
    for asset_root in ASSET_ROOTS:
        asset_dir = safe_repo_path(root, asset_root)
        if asset_dir.is_dir():
            for path in sorted(asset_dir.rglob("*")):
                if path.is_file() and path.suffix.lower() in PROTECTED_EXTENSIONS:
                    if path.is_symlink():
                        raise RuntimeError(f"protected asset must not be a symlink: {path}")
                    rel = path.relative_to(root).as_posix()
                    assets[rel] = sha256_file(path)

    surfaces: dict[str, dict[str, object]] = {}
    for rel_path in discover_surfaces(root):
        path = safe_repo_path(root, rel_path)
        lines = normalize_visual_lines(path)
        payload = "\n".join(lines).encode("utf-8")
        surfaces[rel_path.as_posix()] = {
            "visual_line_count": len(lines),
            "visual_fingerprint": sha256_bytes(payload),
        }

    if not assets:
        roots = ", ".join(str(safe_repo_path(root, path)) for path in ASSET_ROOTS)
        raise RuntimeError(f"no protected visual assets found under: {roots}")
    if not surfaces:
        raise RuntimeError("none of the protected or discovered visual surfaces exist")

    return {
        "schema": 2,
        "captured_at": datetime.now(timezone.utc).isoformat(),
        "assets": assets,
        "surfaces": surfaces,
    }


def load_baseline(manifest: Path) -> dict[str, object]:
    baseline = json.loads(manifest.read_text(encoding="utf-8"))
    if not isinstance(baseline, dict):
        raise RuntimeError("visual baseline must be a JSON object")
    return baseline


def verify(root: Path, baseline: dict[str, object]) -> list[str]:
    errors: list[str] = []
    assets = baseline.get("assets")
    surfaces = baseline.get("surfaces")
    if not isinstance(assets, dict) or not isinstance(surfaces, dict):
        return ["baseline is missing assets or surfaces"]

    try:
        schema = int(baseline.get("schema", 1))
    except (TypeError, ValueError):
        return ["baseline schema is invalid"]

    for rel, expected in sorted(assets.items()):
        try:
            path = safe_repo_path(root, str(rel))
        except RuntimeError as exc:
            errors.append(str(exc))
            continue
        if not path.is_file():
            errors.append(f"protected asset missing: {rel}")
            continue
        actual = sha256_file(path)
        if actual != expected:
            errors.append(f"protected asset changed: {rel}")

    for rel, expected_record in sorted(surfaces.items()):
        try:
            path = safe_repo_path(root, str(rel))
        except RuntimeError as exc:
            errors.append(str(exc))
            continue
        if not path.is_file():
            errors.append(f"protected visual surface missing: {rel}")
            continue
        if not isinstance(expected_record, dict):
            errors.append(f"invalid surface record: {rel}")
            continue
        lines = normalize_visual_lines(path)
        # Schema 1 manifests sorted these lines before hashing. Keep old target
        # baselines usable while all newly captured schema 2 manifests preserve
        # and therefore protect source order.
        fingerprint_lines = lines if schema >= 2 else sorted(lines)
        actual = sha256_bytes("\n".join(fingerprint_lines).encode("utf-8"))
        expected = expected_record.get("visual_fingerprint")
        if actual != expected:
            errors.append(f"visual bindings changed: {rel}")

    return errors


def write_json_atomic(path: Path, value: dict[str, object]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temp_name = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    temp = Path(temp_name)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            json.dump(value, handle, indent=2, sort_keys=True)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temp, path)
    except BaseException:
        temp.unlink(missing_ok=True)
        raise


def atomic_copy(source: Path, destination: Path) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temp_name = tempfile.mkstemp(
        prefix=f".{destination.name}.restore-", dir=destination.parent
    )
    os.close(descriptor)
    temp = Path(temp_name)
    try:
        shutil.copy2(source, temp)
        os.replace(temp, destination)
    except BaseException:
        temp.unlink(missing_ok=True)
        raise


def rollback_file_paths(root: Path, baseline: dict[str, object]) -> list[str]:
    assets = baseline.get("assets")
    surfaces = baseline.get("surfaces")
    if not isinstance(assets, dict) or not isinstance(surfaces, dict):
        raise RuntimeError("baseline is missing assets or surfaces")

    paths = {str(path) for path in assets}
    paths.update(str(path) for path in surfaces)

    # A previously non-visual source file can become a visual binding surface in
    # a release. Snapshot the existing web source so drift rollback can also
    # restore the route/import file that introduced that binding.
    for source_root in SOURCE_ROOTS:
        source_dir = safe_repo_path(root, source_root)
        if not source_dir.is_dir():
            continue
        for path in sorted(source_dir.rglob("*")):
            if path.is_file() and path.suffix.lower() in SOURCE_EXTENSIONS:
                if path.is_symlink():
                    raise RuntimeError(f"visual rollback source must not be a symlink: {path}")
                paths.add(path.relative_to(root).as_posix())

    return sorted(paths)


def backup(root: Path, manifest: Path, backup_dir: Path) -> dict[str, object]:
    if not manifest.is_file():
        raise RuntimeError(f"visual baseline is missing: {manifest}")
    baseline = load_baseline(manifest)
    errors = verify(root, baseline)
    if errors:
        raise RuntimeError("refusing to back up an unverified target: " + "; ".join(errors))

    backup_dir = backup_dir.resolve(strict=False)
    if is_within(backup_dir, root) or is_within(root, backup_dir):
        raise RuntimeError("backup directory and repository root must be separate")
    if backup_dir.exists():
        raise RuntimeError(f"backup directory already exists: {backup_dir}")

    backup_dir.parent.mkdir(parents=True, exist_ok=True)
    temp_dir = Path(
        tempfile.mkdtemp(prefix=f".{backup_dir.name}.tmp-", dir=backup_dir.parent)
    )
    try:
        files: dict[str, str] = {}
        for rel in rollback_file_paths(root, baseline):
            source = safe_repo_path(root, rel)
            if not source.is_file():
                raise RuntimeError(f"backup source is missing: {rel}")
            if source.is_symlink():
                raise RuntimeError(f"backup source must not be a symlink: {rel}")
            destination = temp_dir / "files" / Path(rel)
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source, destination)
            files[Path(rel).as_posix()] = sha256_file(destination)

        saved_manifest = temp_dir / BACKUP_MANIFEST
        shutil.copy2(manifest, saved_manifest)
        metadata: dict[str, object] = {
            "schema": 1,
            "created_at": datetime.now(timezone.utc).isoformat(),
            "source_root": str(root),
            "baseline_sha256": sha256_file(saved_manifest),
            "files": files,
        }
        write_json_atomic(temp_dir / BACKUP_METADATA, metadata)
        os.replace(temp_dir, backup_dir)
        return metadata
    except BaseException:
        shutil.rmtree(temp_dir, ignore_errors=True)
        raise


def restore(root: Path, manifest: Path, backup_dir: Path) -> dict[str, object]:
    backup_dir = backup_dir.resolve(strict=True)
    if is_within(backup_dir, root) or is_within(root, backup_dir):
        raise RuntimeError("backup directory and repository root must be separate")

    metadata_path = backup_dir / BACKUP_METADATA
    saved_manifest = backup_dir / BACKUP_MANIFEST
    metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
    if not isinstance(metadata, dict) or metadata.get("schema") != 1:
        raise RuntimeError("unsupported or invalid visual backup metadata")
    if metadata.get("source_root") != str(root):
        raise RuntimeError(
            f"backup belongs to {metadata.get('source_root')!r}, not target {str(root)!r}"
        )
    files = metadata.get("files")
    if not isinstance(files, dict) or not files:
        raise RuntimeError("visual backup contains no rollback files")
    if not saved_manifest.is_file():
        raise RuntimeError("visual backup is missing its baseline manifest")
    if sha256_file(saved_manifest) != metadata.get("baseline_sha256"):
        raise RuntimeError("visual backup baseline checksum mismatch")

    validated: list[tuple[Path, Path]] = []
    for rel, expected in sorted(files.items()):
        source = safe_repo_path(backup_dir / "files", str(rel))
        destination = safe_repo_path(root, str(rel))
        if not source.is_file() or source.is_symlink():
            raise RuntimeError(f"visual backup file is missing or unsafe: {rel}")
        if sha256_file(source) != expected:
            raise RuntimeError(f"visual backup checksum mismatch: {rel}")
        validated.append((source, destination))

    # Validate the complete backup before changing any target file.
    for source, destination in validated:
        atomic_copy(source, destination)
    atomic_copy(saved_manifest, manifest)

    baseline = load_baseline(manifest)
    errors = verify(root, baseline)
    if errors:
        raise RuntimeError("restored target did not verify: " + "; ".join(errors))
    return metadata


def print_verification_failure(errors: list[str]) -> None:
    print("target-specific visual preservation check failed:", file=sys.stderr)
    for error in errors:
        print(f"  - {error}", file=sys.stderr)
    print(
        "If the owner explicitly approved a visual change, review it in the "
        "live target and then recapture the baseline.",
        file=sys.stderr,
    )


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("command", choices=("capture", "verify", "backup", "restore"))
    parser.add_argument(
        "--root",
        type=Path,
        default=Path(__file__).resolve().parents[1],
        help="BOS repository root",
    )
    parser.add_argument(
        "--manifest",
        type=Path,
        default=Path("/var/lib/boss/visual-baseline.json"),
        help="target-owned baseline outside the release tree",
    )
    parser.add_argument(
        "--backup-dir",
        type=Path,
        help="new backup directory for backup, or existing backup directory for restore",
    )
    args = parser.parse_args()
    root = args.root.expanduser().resolve(strict=False)
    manifest = args.manifest.expanduser().resolve(strict=False)

    if not root.is_dir():
        print(f"visual preservation check failed: repository root is not a directory: {root}", file=sys.stderr)
        return 2

    try:
        if args.command == "capture":
            record = collect(root)
            write_json_atomic(manifest, record)
            print(
                f"captured {len(record['assets'])} assets and "
                f"{len(record['surfaces'])} surfaces in {manifest}"
            )
            return 0

        if args.command == "backup":
            if args.backup_dir is None:
                parser.error("backup requires --backup-dir")
            metadata = backup(root, manifest, args.backup_dir)
            print(
                f"backed up {len(metadata['files'])} visual rollback files to "
                f"{args.backup_dir.resolve(strict=False)}"
            )
            return 0

        if args.command == "restore":
            if args.backup_dir is None:
                parser.error("restore requires --backup-dir")
            metadata = restore(root, manifest, args.backup_dir)
            print(
                f"restored and verified {len(metadata['files'])} visual rollback files from "
                f"{args.backup_dir.resolve(strict=True)}"
            )
            return 0

        if not manifest.is_file():
            print(
                f"visual baseline is missing: {manifest}\n"
                "Capture the installed target before applying an update; do not "
                "create a baseline from an already-overlaid release.",
                file=sys.stderr,
            )
            return 2
        baseline = load_baseline(manifest)
        errors = verify(root, baseline)
        if errors:
            print_verification_failure(errors)
            return 1
        print(
            f"verified {len(baseline['assets'])} assets and "
            f"{len(baseline['surfaces'])} visual surfaces"
        )
        return 0
    except (OSError, RuntimeError, TypeError, ValueError, json.JSONDecodeError) as exc:
        print(f"visual preservation check failed: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
