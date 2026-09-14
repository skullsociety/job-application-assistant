"""Exercise the real migration on disposable SQLite snapshots, never live records."""
import json
import sqlite3
import tempfile
from contextlib import closing
from pathlib import Path
from .schema import DATABASE_PATH, LOCAL_DATA
from .migrate import migrate, connect


def verify() -> dict:
    with tempfile.TemporaryDirectory(prefix='merge-check-') as directory:
        root = Path(directory)
        source, target = root / 'careersgov/jobs.sqlite3', root / 'linkedin/jobs.sqlite3'
        for original, copy in ((LOCAL_DATA / 'backups/careersgov-jobs.sqlite3', source), (DATABASE_PATH, target)):
            copy.parent.mkdir()
            with closing(connect(original, readonly=True)) as old, closing(sqlite3.connect(copy)) as new:
                old.backup(new)
        with closing(connect(source, readonly=True)) as old:
            originals = [dict(row) for row in old.execute('SELECT * FROM jobs')]
        with closing(connect(target, readonly=True)) as old:
            others = [dict(row) for row in old.execute('SELECT * FROM jobs')]
            previously_imported = {
                row[0] for row in old.execute("SELECT legacy_id FROM legacy_imports WHERE source='careersgov'")
            }
        result = migrate(source, target, apply=True)
        with closing(connect(target, readonly=True)) as merged:
            assert merged.execute('PRAGMA integrity_check').fetchone()[0] == 'ok'
            for original in originals:
                if original['id'] in previously_imported:
                    continue
                row = dict(merged.execute('SELECT * FROM jobs WHERE legacy_careersgov_id=?', (original['id'],)).fetchone())
                for key in ('title', 'company', 'url', 'closing_date', 'employment_type', 'match_score', 'key_skills',
                            'matching_skills', 'missing_skills', 'match_reason', 'recommendation', 'tailored_resume_path',
                            'resume_name', 'applied', 'applied_at', 'notes', 'status', 'follow_up_date', 'followed_up',
                            'followed_up_at', 'location', 'salary', 'job_description', 'first_seen_at', 'last_seen_at'):
                    if key in original:
                        assert row[key] == original[key], (original['id'], key)
            for original in others:
                row = dict(merged.execute('SELECT * FROM jobs WHERE id=?', (original['id'],)).fetchone())
                for key in ('title', 'company', 'url', 'job_description', 'applied', 'applied_at', 'notes', 'status',
                            'match_score', 'matching_skills', 'missing_skills', 'tailored_resume_path', 'followed_up'):
                    assert row[key] == original[key], (original['id'], key)
            assert result['target_records_after'] == len(others) + result['inserted']
        rerun = migrate(source, target, apply=True)
        assert rerun['inserted'] == 0
        return {key: value for key, value in result.items() if key != 'backup_folder'} | {'integrity': 'ok', 'fields_preserved': True, 'repeat_import_duplicates': 0}


if __name__ == '__main__':
    print(json.dumps(verify(), indent=2))
