"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const projectRoot = path.resolve(__dirname, "../..");
const siteRoot = path.join(projectRoot, "extension", "sites", "jobstreet");

test("side panel element bindings match its HTML", () => {
  const script = fs.readFileSync(path.join(siteRoot, "sidepanel.js"), "utf8");
  const document = fs.readFileSync(path.join(siteRoot, "sidepanel.html"), "utf8");
  const declarations = [...script.matchAll(/(\w+):\s*document\.querySelector\("#([^"\s]+)"\)/g)];
  const declaredNames = new Set(declarations.map((match) => match[1]));
  const referencedNames = new Set([...script.matchAll(/elements\.(\w+)/g)].map((match) => match[1]));
  const htmlIds = new Set([...document.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]));

  assert.deepEqual([...referencedNames].filter((name) => !declaredNames.has(name)), []);
  assert.deepEqual(declarations.filter((match) => !htmlIds.has(match[2])).map((match) => match[2]), []);
});

test("extension access is limited to JobStreet, supported SuccessFactors pages and its local companion", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(projectRoot, "extension", "manifest.json"), "utf8"));
  assert.ok(manifest.permissions.includes("scripting"));
  assert.ok(manifest.permissions.includes("activeTab"));
  assert.ok(manifest.permissions.includes("storage"));
  assert.equal(manifest.content_scripts.length, 4);
  assert.deepEqual(manifest.content_scripts[3].js, ['successfactors-core.js', 'successfactors-autofill.js']);
  assert.deepEqual(manifest.content_scripts[1].js, ["sites/jobstreet/content.js"]);
  assert.ok(manifest.content_scripts[1].matches.every((permission) => permission.startsWith("https://") && permission.includes("jobstreet.com")));
  assert.ok(manifest.host_permissions.some((permission) => permission === "http://127.0.0.1:8767/*"));
  assert.ok(manifest.host_permissions.some((permission) => permission.includes("jobstreet.com")));
  assert.ok(!manifest.host_permissions.includes("<all_urls>"));
  assert.equal(fs.existsSync(path.join(siteRoot, "content.js")), true);
});

test("content script extracts one visible JobStreet detail page and never operates application forms", () => {
  const script = fs.readFileSync(path.join(siteRoot, "content.js"), "utf8");
  for (const expected of [
    "job-detail-title",
    "advertiser-name",
    "job-detail-location",
    "job-detail-work-type",
    "job-detail-salary",
    "jobAdDetails",
    "application/ld+json",
    "JobPosting",
    "datePosted",
    "hiringOrganization",
    "AUTO_CAPTURE_JOBSTREET_JOB",
  ]) assert.match(script, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(script, /MutationObserver/);
  assert.ok(script.includes("job\\/(\\d+)"));
  assert.doesNotMatch(script, /chrome\.tabs\.create/);
  assert.doesNotMatch(script, /\.click\s*\(/);
  assert.doesNotMatch(script, /querySelectorAll\(["'](?:input|form|textarea|select)/);
});

test("side panel auto-populates editable JobStreet fields and displays LinkedIn matches", () => {
  const script = fs.readFileSync(path.join(siteRoot, "sidepanel.js"), "utf8");
  assert.match(script, /EXTRACT_JOBSTREET_JOB/);
  assert.match(script, /SAVE_JOBSTREET_JOB/);
  assert.match(script, /SAVE_JOBSTREET_SETTINGS/);
  assert.match(script, /populateForm/);
  assert.match(script, /related_jobs/);
  assert.match(script, /LinkedIn/);
  assert.match(script, /chrome\.tabs/);
  assert.match(script, /executeScript/);
});

test("automatic capture defaults on, remains switchable, and uses the normal database save path", () => {
  const worker = fs.readFileSync(path.join(siteRoot, "worker.js"), "utf8");
  assert.match(worker, /jobstreetAutoCapture/);
  assert.match(worker, /\[AUTO_CAPTURE_KEY\]: true/);
  assert.match(worker, /AUTO_CAPTURE_JOBSTREET_JOB/);
  assert.match(worker, /captureCurrentJob\(sender\.tab\)/);
  assert.match(worker, /saveJob\(extraction\.job\)/);
  assert.match(worker, /SAVE_JOBSTREET_SETTINGS/);
});

test("split search/detail pages use the selected jobId and selected-card metadata", () => {
  const content = fs.readFileSync(path.join(siteRoot, "content.js"), "utf8");
  const worker = fs.readFileSync(path.join(siteRoot, "worker.js"), "utf8");
  const panel = fs.readFileSync(path.join(siteRoot, "sidepanel.js"), "utf8");
  assert.match(content, /searchParams\.get\("jobId"\)/);
  assert.match(content, /article\[data-job-id=/);
  assert.match(content, /aria-selected/);
  assert.match(content, /splitViewDetailsMatch/);
  assert.match(content, /jobListingDate/);
  assert.match(content, /job-card-company-logo-link/);
  assert.match(content, /job-detail-apply/);
  assert.match(worker, /searchParams\.get\("jobId"\)/);
  assert.match(panel, /searchParams\.get\("jobId"\)/);
});
