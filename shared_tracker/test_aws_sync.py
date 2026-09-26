from __future__ import annotations

import json
import sqlite3
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from urllib.error import URLError

from shared_tracker.aws_sync import AwsSyncConfig, sync_once
from sync_to_aws import main as sync_command


class FakeResponse:
    def __init__(self, body: dict[str, object]) -> None:
        self.body = json.dumps(body).encode("utf-8")

    def __enter__(self) -> "FakeResponse":
        return self

    def __exit__(self, *_: object) -> None:
        return None

    def read(self) -> bytes:
        return self.body


class AwsSyncTests(unittest.TestCase):
    def setUp(self) -> None:
        self.directory = tempfile.TemporaryDirectory()
        self.path = Path(self.directory.name) / "jobs.sqlite3"
        connection = sqlite3.connect(self.path)
        try:
            connection.executescript("""
                CREATE TABLE aws_sync_outbox (
                    sequence INTEGER NOT NULL UNIQUE, event_id TEXT NOT NULL UNIQUE,
                    record_key TEXT NOT NULL, operation TEXT NOT NULL, payload_json TEXT NOT NULL,
                    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                    attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT, sent_at TEXT
                );
                INSERT INTO aws_sync_outbox(sequence, event_id, record_key, operation, payload_json)
                VALUES (1, 'event-1', 'local:1', 'upsert', '{"source":"linkedin"}'),
                       (2, 'event-2', 'local:2', 'delete', '{}');
            """)
            connection.commit()
        finally:
            connection.close()
        self.config = AwsSyncConfig("https://ingest.example.test/events", "test-token")

    def tearDown(self) -> None:
        self.directory.cleanup()

    def test_sync_sends_one_batch_and_acknowledges_only_confirmed_events(self) -> None:
        requests = []

        def opener(request, timeout):
            requests.append((request, timeout))
            body = json.loads(request.data.decode("utf-8"))
            return FakeResponse({"accepted_event_ids": [event["event_id"] for event in body["events"]]})

        self.assertEqual(2, sync_once(self.path, self.config, opener=opener))
        self.assertEqual(1, len(requests))
        self.assertEqual(2, len(json.loads(requests[0][0].data.decode("utf-8"))["events"]))
        connection = sqlite3.connect(self.path)
        try:
            self.assertEqual(2, connection.execute("SELECT COUNT(*) FROM aws_sync_outbox WHERE sent_at IS NOT NULL").fetchone()[0])
        finally:
            connection.close()

    def test_failed_request_keeps_events_for_retry(self) -> None:
        def opener(*_args, **_kwargs):
            raise URLError("offline")

        with self.assertRaisesRegex(RuntimeError, "request failed"):
            sync_once(self.path, self.config, opener=opener)
        connection = sqlite3.connect(self.path)
        try:
            unsent, attempts = connection.execute(
                "SELECT COUNT(*), MIN(attempts) FROM aws_sync_outbox WHERE sent_at IS NULL"
            ).fetchone()
        finally:
            connection.close()
        self.assertEqual((2, 1), (unsent, attempts))

    def test_drain_sends_more_than_one_batch(self) -> None:
        with patch("sync_to_aws.load_dotenv"), \
                patch("sync_to_aws.AwsSyncConfig.from_environment", return_value=self.config), \
                patch("sync_to_aws.sync_once", side_effect=[100, 20, 0]) as sender, \
                patch("sys.argv", ["sync_to_aws.py", "--database", str(self.path), "--drain"]):
            self.assertEqual(0, sync_command())
        self.assertEqual(3, sender.call_count)


if __name__ == "__main__":
    unittest.main()
