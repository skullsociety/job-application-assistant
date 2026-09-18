# Job Application Assistant Suite

One local, review-first Chrome extension and job tracker for LinkedIn, JobStreet and Careers@Gov. Website capture logic stays isolated in small site adapters, while the database, dashboard, Excel export, resume source, application autofill profile and Chrome lifecycle helper are shared.

## Folder layout

```text
job-assistant-suite/
├── extension/                One Chrome extension with three site modules
├── linkedin/                 LinkedIn local service and matching adapter
├── jobstreet/                JobStreet local service and dashboard adapter
├── careersgov/               Careers@Gov local service and matching adapter
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
- Cover-letter text drafts: `local-data/exports/cover_letters/`
- Editable autofill profile: `local-data/private/autofill-profile.local.json`
- Troubleshooting logs: `local-data/logs/`

## First-time setup on Windows

1. Install current versions of Python, Node.js and Google Chrome.
2. Double-click **Setup Job Assistant Suite.bat**. It creates one private Python environment, installs the shared dependencies, packages common extension files and registers the local Chrome helper for the current Windows user.
3. Open `chrome://extensions`, enable **Developer mode**, and remove the three older job-assistant extensions. Your database, resumes and autofill profile are stored outside Chrome and are not deleted.
4. Choose **Load unpacked** once and select `extension/`. Refresh any job/application tabs already open.

The unified extension has a stable ID, so setup no longer reads Chrome profile preferences to discover it. If the suite is moved, run the setup batch file again so Windows records the new helper path.

Opening Chrome starts the local adapters quietly. Closing the final Chrome window releases the extension connection; approximately five seconds later, the helper stops only the assistant processes it started. Chrome cannot directly execute a batch file, so this uses Chrome native messaging with a fixed `start` request and no arbitrary command execution.

## Everyday use

The side panel detects the active website and displays its matching capture interface. Ctrl+Q captures the current supported listing and Ctrl+M opens the dashboard. All captures appear on the shared dashboard without a manual refresh. Sorting, applied status, follow-up dates, notes, deletion, resume matching, tailored PDFs and Excel export remain available.

Only the follow-up date is displayed. Entering a date stores **Followed Up = Yes**; clearing it stores **No**. The derived field remains in the database and Excel export.

Put a new text-readable PDF or DOCX resume in `local-data/resumes/`. The newest resume supplies facts it explicitly contains, such as a name, contact details, skills, education and employment. Missing or uncertain details stay blank. Open **Autofill profile** from the extension, fill any blanks manually, and review the extracted values. Your saved edits take priority over resume defaults and remain private on this computer.

The autofill editor shows its fields only after it has loaded your saved values. If the local assistant is unavailable, use **Retry loading**; the editor will not let a blank loading screen overwrite your saved answers. If the profile changed in another tab, reload before saving. Each successful save keeps the previous profile as `local-data/private/autofill-profile.local.json.bak` for recovery.

If the editor says it cannot load saved answers after an update, fully exit Chrome and restart the local companions before reloading the unpacked extension at `chrome://extensions`. A still-running older companion cannot serve a newer profile format. The editor keeps Save unavailable until it receives the current profile.

The autofill preserves existing answers and never submits an application. Passwords, verification, declarations, file uploads, Save/Continue and final submission stay manual. Review every generated answer before using it.

After capturing a job, open its **Cover letter** section in the extension and click **Generate and save .txt draft**. The draft uses the captured job description and only skills recognized in both that description and your newest resume. It is saved under `local-data/exports/cover_letters/` with the job ID at the start of the filename. Review the draft, then click **Copy cover letter** to paste it into an application. Generating again updates that job's draft file.

## GitHub and privacy

`local-data/` is intentionally excluded from Git. It contains captured jobs, browser state/cookies, resumes, generated documents, logs and personal autofill answers. The ignore rules also exclude local environments, configuration files, databases, documents and legacy generated folders anywhere else in the repository.

Before publishing, run `git status --short` and `git check-ignore -v local-data/jobs.sqlite3`. Confirm the database is ignored and inspect every staged file. Git ignore rules do not remove secrets already committed in older history and do not protect a manually created ZIP of the whole folder.

The existing Git history and remote were preserved from the LinkedIn project. The current remote still has its original LinkedIn-specific repository name; create or select the intended combined GitHub repository before pushing this suite.

## Development and testing

Site-specific browser modules live in `extension/sites/`. Shared autofill source lives in `shared_tracker/extension/`; run `node chrome-helper/sync-extension-assets.js` after editing it. Setup runs this automatically and writes the generated copies into the unified `extension/` folder.

Run `npm install` once before the JavaScript developer checks, then use `npm test`. Run Python tests with the suite environment, for example `.\.venv\Scripts\python.exe -m unittest discover -s shared_tracker`; repeat with `linkedin\tests`, `jobstreet\tests` and `careersgov\companion`.

If setup or startup fails, inspect `local-data/logs/`. The legacy Careers@Gov database and earlier verification export were retained under `local-data/backups/`; they are recovery data, not active trackers.
