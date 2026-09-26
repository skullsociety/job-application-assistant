"""Additive fields and one canonical job-description representation."""
from __future__ import annotations

import sqlite3
import re
from pathlib import Path
from urllib.parse import urlsplit

WORKSPACE = Path(__file__).resolve().parent.parent
LOCAL_DATA = WORKSPACE / "local-data"
DATABASE_PATH = LOCAL_DATA / "jobs.sqlite3"
EXPORT_PATH = LOCAL_DATA / "exports" / "job_tracker.xlsx"
EXTRA_COLUMNS = {
    "closing_date": "TEXT", "key_skills": "TEXT", "resume_name": "TEXT",
    "source_job_id": "TEXT", "legacy_careersgov_id": "INTEGER",
    # Compatibility aliases retained for existing Careers@Gov clients.
    "description": "TEXT", "captured_at": "TEXT",
    "submission_approved_at": "TEXT",
}


def add_shared_columns(connection: sqlite3.Connection) -> None:
    existing = {row[1] for row in connection.execute("PRAGMA table_info(jobs)")}
    for name, definition in EXTRA_COLUMNS.items():
        if name not in existing:
            connection.execute(f"ALTER TABLE jobs ADD COLUMN {name} {definition}")


def normalize_shared_rows(connection: sqlite3.Connection) -> None:
    """Only fill absent aliases. Never invent salaries, locations or skills."""
    connection.execute("""UPDATE jobs SET
        description=COALESCE(description, job_description),
        job_description=COALESCE(job_description, description),
        captured_at=COALESCE(captured_at, first_seen_at, created_at),
        platform=CASE source WHEN 'careersgov' THEN 'Careers@Gov'
            WHEN 'jobstreet' THEN 'JobStreet' WHEN 'linkedin' THEN 'LinkedIn' ELSE platform END
        WHERE description IS NULL OR job_description IS NULL OR captured_at IS NULL
            OR platform IS NULL OR platform=''""")
    # Followed Up is now derived from the scheduled date, not an independent UI choice.
    connection.execute("""UPDATE jobs SET followed_up=CASE WHEN NULLIF(TRIM(follow_up_date), '') IS NOT NULL THEN 1 ELSE 0 END,
        followed_up_at=CASE WHEN NULLIF(TRIM(follow_up_date), '') IS NULL THEN NULL ELSE followed_up_at END
        WHERE followed_up <> CASE WHEN NULLIF(TRIM(follow_up_date), '') IS NOT NULL THEN 1 ELSE 0 END""")
    for row in connection.execute("SELECT id, url, notes, source_job_id, key_skills FROM jobs WHERE source_job_id IS NULL OR key_skills IS NULL").fetchall():
        identifier, url, notes, source_id, skills = row
        if source_id is None:
            parsed = urlsplit(url)
            if parsed.hostname in {'www.linkedin.com', 'linkedin.com', 'jobs.careers.gov.sg'} or re.fullmatch(r'(?:[a-z0-9-]+\.)*jobstreet\.com(?:\.[a-z]{2})?', parsed.hostname or ''):
                source_id = parsed.path.rstrip('/').rsplit('/', 1)[-1]
        if skills is None and (notes or '').startswith('Skills mentioned: '):
            original_skills = notes.split('\n', 1)[0].removeprefix('Skills mentioned: ').strip()
            if not original_skills.startswith('None recognized'):
                skills = original_skills
        connection.execute('UPDATE jobs SET source_job_id=?, key_skills=? WHERE id=?', (source_id, skills, identifier))


def install_aws_sync_outbox(connection: sqlite3.Connection) -> None:
    """Install transactional change capture for the minimal dashboard snapshot.

    Existing rows are deliberately not backfilled: only changes made after this
    migration are queued. The record key uses the local SQLite row ID; the JSON
    snapshot excludes URLs, descriptions, notes, and resume data.
    """
    connection.execute("""
        CREATE TABLE IF NOT EXISTS aws_sync_outbox (
            sequence INTEGER NOT NULL UNIQUE,
            event_id TEXT NOT NULL UNIQUE,
            record_key TEXT NOT NULL,
            operation TEXT NOT NULL CHECK(operation IN ('upsert', 'delete')),
            payload_json TEXT NOT NULL,
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            attempts INTEGER NOT NULL DEFAULT 0,
            last_error TEXT,
            sent_at TEXT
        )
    """)
    existing = {row[1] for row in connection.execute("PRAGMA table_info(aws_sync_outbox)")}
    if "sequence" not in existing:
        connection.execute("ALTER TABLE aws_sync_outbox ADD COLUMN sequence INTEGER")
        connection.execute("UPDATE aws_sync_outbox SET sequence = rowid WHERE sequence IS NULL")
    connection.execute("CREATE INDEX IF NOT EXISTS idx_aws_sync_outbox_pending_sequence ON aws_sync_outbox(sent_at, sequence)")
    connection.executescript("""
        CREATE TRIGGER IF NOT EXISTS jobs_aws_sync_insert AFTER INSERT ON jobs
        BEGIN
            INSERT INTO aws_sync_outbox(sequence, event_id, record_key, operation, payload_json)
            VALUES (
                (SELECT COALESCE(MAX(sequence), 0) + 1 FROM aws_sync_outbox),
                lower(hex(randomblob(16))),
                'local:' || NEW.id,
                'upsert',
                json_object('source', NEW.source, 'date_found', NEW.date_found,
                    'status', NEW.status, 'applied', NEW.applied,
                    'applied_at', NEW.applied_at, 'follow_up_date', NEW.follow_up_date,
                    'followed_up', NEW.followed_up)
            );
        END;

        CREATE TRIGGER IF NOT EXISTS jobs_aws_sync_update AFTER UPDATE ON jobs
        WHEN OLD.source IS NOT NEW.source OR OLD.date_found IS NOT NEW.date_found
          OR OLD.status IS NOT NEW.status OR OLD.applied IS NOT NEW.applied
          OR OLD.applied_at IS NOT NEW.applied_at
          OR OLD.follow_up_date IS NOT NEW.follow_up_date
          OR OLD.followed_up IS NOT NEW.followed_up
        BEGIN
            INSERT INTO aws_sync_outbox(sequence, event_id, record_key, operation, payload_json)
            VALUES (
                (SELECT COALESCE(MAX(sequence), 0) + 1 FROM aws_sync_outbox),
                lower(hex(randomblob(16))),
                'local:' || NEW.id,
                'upsert',
                json_object('source', NEW.source, 'date_found', NEW.date_found,
                    'status', NEW.status, 'applied', NEW.applied,
                    'applied_at', NEW.applied_at, 'follow_up_date', NEW.follow_up_date,
                    'followed_up', NEW.followed_up)
            );
        END;

        CREATE TRIGGER IF NOT EXISTS jobs_aws_sync_delete AFTER DELETE ON jobs
        BEGIN
            INSERT INTO aws_sync_outbox(sequence, event_id, record_key, operation, payload_json)
            VALUES (
                (SELECT COALESCE(MAX(sequence), 0) + 1 FROM aws_sync_outbox),
                lower(hex(randomblob(16))),
                'local:' || OLD.id,
                'delete', '{}'
            );
        END;
    """)
