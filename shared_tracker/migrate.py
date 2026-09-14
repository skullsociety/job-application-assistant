"""Back up and import Careers@Gov records once, retaining a durable ID map.

Run from the workspace: python -m shared_tracker.migrate [--apply]
The default is a read-only preview. Stop companion servers before --apply.
"""
from __future__ import annotations

import argparse
import json
import re
import shutil
import sqlite3
import sys
from contextlib import closing
from datetime import datetime
from pathlib import Path

from .schema import DATABASE_PATH, LOCAL_DATA, WORKSPACE


def connect(path: Path, *, readonly: bool = False) -> sqlite3.Connection:
    connection = sqlite3.connect(path.resolve().as_uri() + "?mode=ro", uri=True) if readonly else sqlite3.connect(path, timeout=30)
    connection.row_factory = sqlite3.Row
    return connection


def backup_database(path: Path, folder: Path) -> None:
    if not path.is_file():
        return
    folder.mkdir(parents=True, exist_ok=True)
    with closing(connect(path, readonly=True)) as source, closing(sqlite3.connect(folder / (path.parent.parent.name + "-jobs.sqlite3.bak"))) as target:
        source.backup(target)


def migrate(source: Path, target: Path, *, apply: bool = False, resume_root: Path | None = None) -> dict:
    with closing(connect(source, readonly=True)) as old:
        rows = [dict(row) for row in old.execute("SELECT * FROM jobs ORDER BY id")]
    before = 0
    if target.is_file():
        with closing(connect(target, readonly=True)) as database:
            before = database.execute("SELECT count(*) FROM jobs").fetchone()[0]
    result = {"source_records": len(rows), "target_records_before": before, "apply": apply}
    if not apply:
        return result
    backup_root = LOCAL_DATA / "backups" / "migration-backups" if target.resolve() == DATABASE_PATH.resolve() else target.parent / "migration-backups"
    backup = backup_root / datetime.now().strftime("%Y%m%d-%H%M%S-%f")
    backup_database(source, backup)
    backup_database(target, backup)
    sys.path.insert(0, str(WORKSPACE / "linkedin"))
    from job_assistant.database import JobRepository
    # Uses the same additive schema as the running LinkedIn/JobStreet adapters.
    with JobRepository(target):
        pass
    inserted = skipped = 0
    with closing(connect(target)) as database:
        database.execute("PRAGMA foreign_keys = ON")
        database.execute("BEGIN IMMEDIATE")
        database.execute("""CREATE TABLE IF NOT EXISTS legacy_imports (
            source TEXT NOT NULL, legacy_id INTEGER NOT NULL, job_id INTEGER,
            original_json TEXT NOT NULL, imported_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY(source, legacy_id))""")
        columns = {row[1] for row in database.execute("PRAGMA table_info(jobs)")}
        for original in rows:
            legacy_id = original["id"]
            if database.execute("SELECT 1 FROM legacy_imports WHERE source='careersgov' AND legacy_id=?", (legacy_id,)).fetchone():
                skipped += 1
                continue  # Also prevents a deleted job from reappearing on a later migration.
            values = {key: value for key, value in original.items() if key in columns and key != "id"}
            description = original.get("job_description") or original.get("description")
            captured = original.get("captured_at") or original.get("created_at")
            values.update(source="careersgov", platform="Careers@Gov", legacy_careersgov_id=legacy_id,
                          job_description=description, description=description,
                          source_job_id=original["url"].rstrip("/").rsplit("/", 1)[-1],
                          captured_at=captured, date_found=original.get("date_found") or (captured or "")[:10],
                          created_at=original.get("created_at") or captured,
                          first_seen_at=original.get("first_seen_at") or captured,
                          last_seen_at=original.get("last_seen_at") or original.get("updated_at") or captured)
            # Existing Careers@Gov PDFs stay in their original folder. API links
            # resolve them by source and the stored filename, not arbitrary paths.
            existing = database.execute("SELECT id FROM jobs WHERE url=?", (values["url"],)).fetchone()
            if existing:
                job_id = existing["id"]
                # Do not overwrite user tracking or newer capture data on a URL collision.
                assignments = ", ".join(f'"{key}"=COALESCE("{key}", ?)' for key in values if key != "url")
                database.execute(f"UPDATE jobs SET {assignments} WHERE id=?", (*[v for k, v in values.items() if k != "url"], job_id))
            else:
                fields = ", ".join(f'"{key}"' for key in values)
                cursor = database.execute(f"INSERT INTO jobs ({fields}) VALUES ({','.join('?' for _ in values)})", tuple(values.values()))
                job_id = cursor.lastrowid
                inserted += 1
            old_name = original.get("tailored_resume_path")
            if resume_root and old_name and Path(old_name).name == old_name:
                old_file = resume_root / old_name
                new_name = f"{job_id}_" + re.sub(r"^\d+_", "", old_name)
                new_file = resume_root / new_name
                if old_file.is_file() and new_file != old_file:
                    if new_file.exists() and new_file.read_bytes() != old_file.read_bytes():
                        new_name = f"{job_id}_imported_careersgov_{legacy_id}.pdf"
                        new_file = resume_root / new_name
                    if not new_file.exists():
                        shutil.copy2(old_file, new_file)
                    database.execute("UPDATE jobs SET tailored_resume_path=? WHERE id=?", (new_name, job_id))
            database.execute("INSERT INTO legacy_imports (source,legacy_id,job_id,original_json) VALUES ('careersgov',?,?,?)",
                             (legacy_id, job_id, json.dumps(original, ensure_ascii=False)))
        if database.execute("PRAGMA foreign_key_check").fetchone():
            raise RuntimeError("Migration failed the relationship integrity check.")
        database.commit()
        result.update(inserted=inserted, already_imported=skipped,
                      target_records_after=database.execute("SELECT count(*) FROM jobs").fetchone()[0],
                      backup_folder=str(backup))
    return result


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()
    print(json.dumps(migrate(LOCAL_DATA / "backups/careersgov-jobs.sqlite3", DATABASE_PATH, apply=args.apply,
                             resume_root=LOCAL_DATA / "exports/tailored_resumes"), indent=2))
