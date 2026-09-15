# Job Application Assistant Suite

One local, review-first job tracker for LinkedIn, JobStreet and Careers@Gov. Each website keeps its own Chrome extension and capture logic, while the database, dashboard, Excel export, resume source, application autofill profile and Chrome lifecycle helper are shared.

## Folder layout

```text
job-assistant-suite/
├── linkedin/                 LinkedIn extension and adapter
├── jobstreet/                JobStreet extension and dashboard adapter
├── careersgov/               Careers@Gov extension and adapter
├── shared_tracker/           Shared database schema, dashboard and autofill source
├── chrome-helper/            Shared Chrome startup/shutdown helper
├── local-data/               Private local data; never committed
├── requirements.txt          One Python dependency list
└── Setup Job Assistant Suite.bat
```

The three local adapters use ports 8765–8767, but they all use one database and one dashboard:

- Dashboard: <http://127.0.0.1:8767/>
- Database: `local-data/jobs.sqlite3`
- Excel tracker: `local-data/exports/job_tracker.xlsx`
- Source resumes: `local-data/resumes/`
- Tailored resumes: `local-data/exports/tailored_resumes/`
- Editable autofill profile: `local-data/private/autofill-profile.local.json`
- Troubleshooting logs: `local-data/logs/`

## First-time setup on Windows

1. Install current versions of Python, Node.js and Google Chrome.
2. Double-click **Setup Job Assistant Suite.bat**. It creates one private Python environment, installs the shared dependencies, packages common extension files and registers the local Chrome helper for the current Windows user.
3. Open `chrome://extensions`, enable **Developer mode**, and choose **Load unpacked** for each folder:
   - `linkedin/extension`
   - `jobstreet/extension`
   - `careersgov/extension`
4. Reload each extension once. Refresh any job/application tabs already open.

The extensions have stable IDs, so setup no longer reads Chrome profile preferences to discover an ID. If the suite is moved, run the setup batch file again so Windows records the new helper path.

Opening Chrome starts the local adapters quietly. Closing the final Chrome window releases the extension connections; approximately five seconds later, the helper stops only the assistant processes it started. Chrome cannot directly execute a batch file, so this uses Chrome native messaging with a fixed `start` request and no arbitrary command execution.

## Everyday use

Capture jobs with each site’s extension. All captures appear on the shared dashboard and the page updates without a manual refresh. Sorting, applied status, follow-up dates, notes, deletion, resume matching, tailored PDFs and Excel export remain available.

Only the follow-up date is displayed. Entering a date stores **Followed Up = Yes**; clearing it stores **No**. The derived field remains in the database and Excel export.

Put a new text-readable PDF or DOCX resume in `local-data/resumes/`. The newest resume supplies skills, education and employment only. Open **Workday / SuccessFactors autofill defaults** from any extension, enter contact and application details manually, and review the extracted resume history. Saved values remain private and are shared by all three extensions on this computer.

The autofill preserves existing answers and never submits an application. Passwords, verification, declarations, file uploads, Save/Continue and final submission stay manual. Review every generated answer before using it.

## GitHub and privacy

`local-data/` is intentionally excluded from Git. It contains captured jobs, browser state/cookies, resumes, generated documents, logs and personal autofill answers. The ignore rules also exclude local environments, configuration files, databases, documents and legacy generated folders anywhere else in the repository.

Before publishing, run `git status --short` and `git check-ignore -v local-data/jobs.sqlite3`. Confirm the database is ignored and inspect every staged file. Git ignore rules do not remove secrets already committed in older history and do not protect a manually created ZIP of the whole folder.

The existing Git history and remote were preserved from the LinkedIn project. The current remote still has its original LinkedIn-specific repository name; create or select the intended combined GitHub repository before pushing this suite.

## Development and testing

Shared extension files live in `shared_tracker/extension/`. Run `node chrome-helper/sync-extension-assets.js` after editing them; setup runs this automatically. Generated copies must remain inside all three unpacked extension folders for Chrome, but Git tracks only the shared source.

Run `npm install` once before the JavaScript developer checks, then use `npm test`. Run Python tests with the suite environment, for example `.\.venv\Scripts\python.exe -m unittest discover -s shared_tracker`; repeat with `linkedin\tests`, `jobstreet\tests` and `careersgov\companion`.

If setup or startup fails, inspect `local-data/logs/`. The legacy Careers@Gov database and earlier verification export were retained under `local-data/backups/`; they are recovery data, not active trackers.
