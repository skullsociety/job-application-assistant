"""Normalize tailored-resume filenames to begin with their dashboard job ID."""
from __future__ import annotations

import argparse
import json
import re
import shutil
import sqlite3
from contextlib import closing
from datetime import datetime
from pathlib import Path

from .schema import DATABASE_PATH, LOCAL_DATA


TAILORED_RESUME_DIR = LOCAL_DATA / "exports" / "tailored_resumes"


def indexed_name(job_id: int, stored_name: str) -> str:
    """Return `<job ID>_...pdf`, removing an obsolete trailing copy of the ID."""
    name = Path(stored_name).name
    if name != stored_name or Path(name).suffix.casefold() != ".pdf":
        raise ValueError(f"Unsafe tailored-resume filename: {stored_name!r}")
    stem = re.sub(r"^\d+_", "", Path(name).stem)
    stem = re.sub(rf"_{job_id}$", "", stem)
    return f"{job_id}_{stem}.pdf"


def normalize(
    database_path: Path = DATABASE_PATH,
    resume_dir: Path = TAILORED_RESUME_DIR,
    *,
    apply: bool = False,
) -> dict:
    with closing(sqlite3.connect(database_path)) as database:
        rows = database.execute(
            """SELECT id, tailored_resume_path FROM jobs
               WHERE tailored_resume_path IS NOT NULL
                 AND length(trim(tailored_resume_path)) > 0
               ORDER BY id"""
        ).fetchall()
        plans = []
        missing = []
        for job_id, old_name in rows:
            new_name = indexed_name(job_id, old_name)
            if new_name == old_name:
                continue
            old_path, new_path = resume_dir / old_name, resume_dir / new_name
            if not old_path.is_file():
                missing.append({"job_id": job_id, "filename": old_name})
                continue
            if new_path.exists() and new_path.read_bytes() != old_path.read_bytes():
                raise FileExistsError(f"Refusing to overwrite a different file: {new_path}")
            plans.append((job_id, old_name, new_name, old_path, new_path))

        referenced_names = {row[1] for row in rows}
        unreferenced_plans = []
        for old_path in sorted(resume_dir.glob("*.pdf")):
            if old_path.name in referenced_names or re.match(r"^\d+_", old_path.name):
                continue
            trailing_id = re.search(r"_(\d+)\.pdf$", old_path.name)
            if not trailing_id:
                raise ValueError(f"Cannot infer a job ID for historical tailored resume: {old_path.name}")
            new_name = indexed_name(int(trailing_id.group(1)), old_path.name)
            new_path = resume_dir / new_name
            if new_path.exists() and new_path.read_bytes() != old_path.read_bytes():
                raise FileExistsError(f"Refusing to overwrite a different file: {new_path}")
            unreferenced_plans.append((old_path, new_path))

        result = {
            "referenced": len(rows),
            "already_indexed": len(rows) - len(plans) - len(missing),
            "to_rename": len(plans),
            "unreferenced_to_rename": len(unreferenced_plans),
            "missing_files": missing,
            "apply": apply,
        }
        if not apply:
            return result
        if missing:
            raise FileNotFoundError("Some database references have no corresponding PDF; no changes were made.")

        backup_dir = LOCAL_DATA / "backups" / "filename-normalization"
        backup_dir.mkdir(parents=True, exist_ok=True)
        backup_path = backup_dir / f"jobs-{datetime.now():%Y%m%d-%H%M%S-%f}.sqlite3"
        with closing(sqlite3.connect(backup_path)) as backup:
            database.backup(backup)

        copied = []
        try:
            file_plans = [(item[3], item[4]) for item in plans] + unreferenced_plans
            for old_path, new_path in file_plans:
                if not new_path.exists():
                    shutil.copy2(old_path, new_path)
                    copied.append(new_path)
            database.execute("BEGIN IMMEDIATE")
            for job_id, old_name, new_name, _, _ in plans:
                cursor = database.execute(
                    "UPDATE jobs SET tailored_resume_path=? WHERE id=? AND tailored_resume_path=?",
                    (new_name, job_id, old_name),
                )
                if cursor.rowcount != 1:
                    raise RuntimeError(f"Job {job_id} changed during filename normalization.")
            database.commit()
        except Exception:
            database.rollback()
            for path in copied:
                path.unlink(missing_ok=True)
            raise

        for _, old_name, _, old_path, _ in plans:
            still_used = database.execute(
                "SELECT 1 FROM jobs WHERE tailored_resume_path=? LIMIT 1", (old_name,)
            ).fetchone()
            if not still_used:
                old_path.unlink(missing_ok=True)
        for old_path, _ in unreferenced_plans:
            old_path.unlink(missing_ok=True)
        result.update(
            renamed=len(plans),
            unreferenced_renamed=len(unreferenced_plans),
            backup=str(backup_path),
        )
        return result


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apply", action="store_true", help="Back up, rename files and update database references")
    arguments = parser.parse_args()
    print(json.dumps(normalize(apply=arguments.apply), indent=2))
