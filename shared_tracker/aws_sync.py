"""Send queued job-dashboard changes from SQLite to the AWS ingestion API."""
from __future__ import annotations

import json
import os
import sqlite3
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

DEFAULT_BATCH_SIZE = 100
DEFAULT_TIMEOUT_SECONDS = 15


@dataclass(frozen=True)
class AwsSyncConfig:
    ingest_url: str
    ingest_token: str
    timeout_seconds: int = DEFAULT_TIMEOUT_SECONDS

    @classmethod
    def from_environment(cls) -> "AwsSyncConfig":
        ingest_url = os.environ.get("JOB_ASSISTANT_AWS_INGEST_URL", "").strip()
        ingest_token = os.environ.get("JOB_ASSISTANT_AWS_INGEST_TOKEN", "").strip()
        if not ingest_url or not ingest_token:
            raise ValueError("Set JOB_ASSISTANT_AWS_INGEST_URL and JOB_ASSISTANT_AWS_INGEST_TOKEN before syncing.")
        if not ingest_url.startswith("https://"):
            raise ValueError("JOB_ASSISTANT_AWS_INGEST_URL must use HTTPS.")
        return cls(ingest_url=ingest_url, ingest_token=ingest_token)


def fetch_pending_events(connection: sqlite3.Connection, limit: int = DEFAULT_BATCH_SIZE) -> list[dict[str, Any]]:
    """Return the oldest unsent events in the order they occurred."""
    if not 1 <= limit <= 1000:
        raise ValueError("limit must be between 1 and 1000")
    rows = connection.execute(
        """SELECT event_id, record_key, operation, payload_json, created_at, attempts
           FROM aws_sync_outbox WHERE sent_at IS NULL
           ORDER BY sequence LIMIT ?""",
        (limit,),
    ).fetchall()
    return [dict(row) for row in rows]


def record_send_failure(connection: sqlite3.Connection, event_id: str, error: str) -> None:
    connection.execute(
        """UPDATE aws_sync_outbox SET attempts = attempts + 1, last_error = ?
           WHERE event_id = ? AND sent_at IS NULL""",
        (error[:1000], event_id),
    )


def acknowledge_event(connection: sqlite3.Connection, event_id: str) -> None:
    connection.execute(
        """UPDATE aws_sync_outbox SET sent_at = CURRENT_TIMESTAMP, last_error = NULL,
                  attempts = attempts + 1
           WHERE event_id = ? AND sent_at IS NULL""",
        (event_id,),
    )


def _wire_event(event: dict[str, Any]) -> dict[str, Any]:
    return {
        "event_id": event["event_id"],
        "record_key": event["record_key"],
        "operation": event["operation"],
        "occurred_at": event["created_at"],
        "payload": json.loads(event["payload_json"]),
    }


def send_batch(config: AwsSyncConfig, events: list[dict[str, Any]], opener: Callable[..., Any] = urlopen) -> list[str]:
    """Send one batch and return exactly the event IDs confirmed by AWS."""
    event_ids = [event["event_id"] for event in events]
    body = json.dumps({"schema_version": 1, "events": [_wire_event(event) for event in events]}).encode("utf-8")
    request = Request(
        config.ingest_url,
        data=body,
        method="POST",
        headers={"Content-Type": "application/json", "Accept": "application/json", "X-Job-Assistant-Token": config.ingest_token},
    )
    try:
        with opener(request, timeout=config.timeout_seconds) as response:
            response_body = response.read().decode("utf-8")
    except (HTTPError, URLError, TimeoutError, OSError) as error:
        raise RuntimeError(f"AWS ingestion request failed: {error}") from error
    try:
        accepted_ids = json.loads(response_body)["accepted_event_ids"]
    except (KeyError, TypeError, json.JSONDecodeError) as error:
        raise RuntimeError("AWS ingestion response did not confirm accepted_event_ids.") from error
    if not isinstance(accepted_ids, list) or set(accepted_ids) != set(event_ids) or len(accepted_ids) != len(event_ids):
        raise RuntimeError("AWS ingestion response did not confirm every event in the batch.")
    return accepted_ids


def sync_once(
    database_path: Path,
    config: AwsSyncConfig,
    batch_size: int = DEFAULT_BATCH_SIZE,
    opener: Callable[..., Any] = urlopen,
) -> int:
    """Upload one batch and mark it sent only after the AWS confirmation."""
    connection = sqlite3.connect(database_path, timeout=30)
    connection.row_factory = sqlite3.Row
    try:
        events = fetch_pending_events(connection, batch_size)
        if not events:
            return 0
        try:
            accepted_ids = send_batch(config, events, opener)
        except RuntimeError as error:
            for event in events:
                record_send_failure(connection, event["event_id"], str(error))
            connection.commit()
            raise
        for event_id in accepted_ids:
            acknowledge_event(connection, event_id)
        connection.commit()
        return len(accepted_ids)
    finally:
        connection.close()
