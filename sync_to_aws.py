"""Manual command for sending the next queued job-dashboard batch to AWS."""
from __future__ import annotations

import argparse
from pathlib import Path

from dotenv import load_dotenv

from shared_tracker.aws_sync import AwsSyncConfig, sync_once
from shared_tracker.schema import DATABASE_PATH


def main() -> int:
    load_dotenv()
    parser = argparse.ArgumentParser(description="Send one local job-dashboard batch to AWS.")
    parser.add_argument("--database", type=Path, default=DATABASE_PATH)
    parser.add_argument("--batch-size", type=int, default=100)
    parser.add_argument("--drain", action="store_true", help="Send all pending batches, stopping on the first failure.")
    arguments = parser.parse_args()
    config = AwsSyncConfig.from_environment()
    total_sent = 0
    while True:
        sent = sync_once(arguments.database, config, arguments.batch_size)
        total_sent += sent
        if not arguments.drain or sent == 0:
            break
    print(f"Sent {total_sent} queued event(s) to AWS.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
