"""Export the same primary tracker columns as LinkedIn and JobStreet."""

from __future__ import annotations

from contextlib import closing
from datetime import date
import sqlite3
from pathlib import Path
from typing import Any
from uuid import uuid4

from openpyxl import Workbook
from openpyxl.formatting.rule import CellIsRule
from openpyxl.styles import Alignment, Font, PatternFill
from openpyxl.worksheet.datavalidation import DataValidation
from openpyxl.worksheet.table import Table, TableStyleInfo

PROJECT_ROOT = Path(__file__).resolve().parent.parent
from .schema import EXPORT_PATH as TRACKER_PATH
HEADERS = [
    "Date", "Platform", "Company", "Role", "URL", "Location", "Salary", "Match Score",
    "Skills Missing for 100% Match", "Status", "Notes", "Follow-up Date", "Followed Up",
]
DETAIL_FIELDS = [
    ("Source", "source"), ("Platform", "platform"), ("Source Job ID", "source_job_id"),
    ("Previous CareersGov ID", "legacy_careersgov_id"), ("ID", "id"), ("Role", "title"), ("Job URL", "url"), ("Employment Type", "employment_type"),
    ("Work Arrangement", "workplace_type"), ("Posting Date", "posting_date"), ("Closing Date", "closing_date"),
    ("Key Skills", "key_skills"), ("Matching Skills", "matching_skills"), ("Missing Skills", "missing_skills"),
    ("Match Reason", "match_reason"), ("Recommendation", "recommendation"), ("Source Resume", "resume_name"),
    ("Tailored Resume", "tailored_resume_path"), ("Application URL", "application_url"),
    ("Company URL", "company_url"), ("Applied", "applied"), ("Applied At", "applied_at"),
    ("Followed Up At", "followed_up_at"), ("Last Seen", "last_seen_at"), ("Seen Count", "seen_count"),
    ("Application Method", "application_method"), ("Seniority", "seniority_level"),
    ("Applicant Count", "applicant_count"), ("Description Hash", "description_hash"),
    ("First Seen", "first_seen_at"), ("Captured At", "captured_at"), ("Created At", "created_at"),
    ("Updated At", "updated_at"), ("Priority", "priority"), ("Interest Level", "interest_level"),
    ("Tags", "tags"), ("LinkedIn Job ID", "linkedin_job_id"),
    ("Submission Approved At", "submission_approved_at"),
    ("Job Description (up to Excel cell limit)", "job_description"),
]


def _as_date(value: str | None) -> date | None:
    if not value:
        return None
    try:
        return date.fromisoformat(value[:10])
    except ValueError:
        return None


def _append_text_safe(sheet: Any, values: list[Any]) -> None:
    sheet.append(values)
    # Scraped values are data, never executable Excel formulas.
    for cell in sheet[sheet.max_row]:
        if isinstance(cell.value, str):
            cell.data_type = "s"
        cell.alignment = Alignment(vertical="top", wrap_text=True)


def export_jobs(jobs: list[dict[str, Any]], output: Path = TRACKER_PATH) -> Path:
    output.parent.mkdir(parents=True, exist_ok=True)
    book = Workbook()
    sheet = book.active
    sheet.title = "Job Tracker"
    sheet.sheet_view.showGridLines = False
    sheet.merge_cells("A1:M1")
    sheet["A1"] = "Unified Job Application Tracker"
    sheet["A1"].font = Font(size=16, bold=True, color="FFFFFF")
    sheet["A1"].fill = PatternFill("solid", fgColor="1F4E78")
    sheet.row_dimensions[1].height = 28
    sheet.append([])
    sheet.append(HEADERS)
    seen = set()
    unique = []
    for job in jobs:
        if job["url"] in seen:
            continue
        seen.add(job["url"])
        unique.append(job)
        _append_text_safe(sheet, [
            _as_date(job.get("date_found") or job.get("captured_at")), job.get("platform") or job.get("source") or "Unknown", job["company"],
            job["title"], job["url"], job.get("location"), job.get("salary"), job.get("match_score"),
            job.get("missing_skills"), job.get("status") or "saved", job.get("notes"),
            _as_date(job.get("follow_up_date")), "Yes" if job.get("followed_up") else "No",
        ])
        sheet.cell(sheet.max_row, 5).hyperlink = job["url"]
        sheet.cell(sheet.max_row, 5).style = "Hyperlink"
        for column in (1, 12):
            sheet.cell(sheet.max_row, column).number_format = "yyyy-mm-dd"
    _style_sheet(sheet, 3, "JobApplications", [13, 14, 24, 28, 48, 22, 16, 13, 34, 25, 42, 16, 14])
    if unique:
        sheet.conditional_formatting.add(f"H4:H{sheet.max_row}", CellIsRule(operator="greaterThanOrEqual", formula=["75"], fill=PatternFill("solid", fgColor="C6E0B4")))
        sheet.conditional_formatting.add(f"H4:H{sheet.max_row}", CellIsRule(operator="lessThan", formula=["35"], fill=PatternFill("solid", fgColor="F4CCCC")))
        for column, formula in (("J", '"saved,reviewing,ready_for_manual_submit,submitted_manually,rejected,archived"'), ("M", '"No,Yes"')):
            validation = DataValidation(type="list", formula1=formula, allow_blank=True)
            sheet.add_data_validation(validation)
            validation.add(f"{column}4:{column}{max(sheet.max_row, 104)}")
    detail = book.create_sheet("Job Details")
    detail.append([label for label, _ in DETAIL_FIELDS])
    for job in unique:
        _append_text_safe(detail, [job.get(key) for _, key in DETAIL_FIELDS])
    _style_sheet(detail, 1, "JobDetails", [10, 32, 48] + [28] * (len(DETAIL_FIELDS) - 3))
    temporary = output.with_name(f".{output.stem}.{uuid4().hex}.xlsx")
    try:
        book.save(temporary)
        temporary.replace(output)
    finally:
        book.close()
        temporary.unlink(missing_ok=True)
    return output


def _style_sheet(sheet: Any, header_row: int, table_name: str, widths: list[int]) -> None:
    from openpyxl.utils import get_column_letter

    sheet.sheet_view.showGridLines = False
    for cell in sheet[header_row]:
        cell.font = Font(bold=True, color="FFFFFF")
        cell.fill = PatternFill("solid", fgColor="2F75B5")
        cell.alignment = Alignment(vertical="center", wrap_text=True)
    sheet.row_dimensions[header_row].height = 30
    for index, width in enumerate(widths, 1):
        sheet.column_dimensions[get_column_letter(index)].width = width
    sheet.freeze_panes = f"A{header_row + 1}"
    if sheet.max_row > header_row:
        table = Table(displayName=table_name, ref=f"A{header_row}:{get_column_letter(len(widths))}{sheet.max_row}")
        table.tableStyleInfo = TableStyleInfo(name="TableStyleMedium2", showRowStripes=True)
        sheet.add_table(table)


def export_database(database: Path, output: Path = TRACKER_PATH) -> Path:
    """Serialize all writers and read the snapshot only after acquiring the lock."""
    with closing(sqlite3.connect(database, timeout=30)) as connection:
        connection.row_factory = sqlite3.Row
        connection.execute("BEGIN IMMEDIATE")
        rows = [dict(row) for row in connection.execute("SELECT * FROM jobs ORDER BY date_found DESC, id DESC")]
        try:
            return export_jobs(rows, output)
        finally:
            connection.rollback()

