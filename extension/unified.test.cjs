"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const root = __dirname;

test("one manifest routes each supported site to an isolated adapter", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
  assert.equal(manifest.name, "Unified Job Application Assistant");
  assert.equal(manifest.background.service_worker, "service-worker.js");
  assert.deepEqual(manifest.content_scripts.slice(0, 3).map(item => item.js), [
    ["sites/linkedin/content.js"],
    ["sites/jobstreet/content.js"],
    ["sites/careersgov/capture-core.js", "sites/careersgov/content.js"],
  ]);
  assert.deepEqual(manifest.content_scripts[3].js, ["successfactors-core.js", "successfactors-autofill.js"]);
  assert.ok(!manifest.host_permissions.includes("<all_urls>"));
});

test("side panel recognizes supported sites and application systems", () => {
  const listeners = [];
  const element = () => ({hidden:false,textContent:"",src:"",addEventListener(){}});
  const context = {
    URL,
    document:{querySelector:element},
    chrome:{tabs:{query:async()=>[],onActivated:{addListener(fn){listeners.push(fn);}},onUpdated:{addListener(fn){listeners.push(fn);}}},runtime:{sendMessage:async()=>({ok:true})}},
    globalThis:{},
  };
  vm.runInNewContext(fs.readFileSync(path.join(root, "sidepanel.js"), "utf8"), context);
  const classify = context.globalThis.UnifiedSidePanel.classify;
  assert.equal(classify("https://www.linkedin.com/jobs/view/1").key, "linkedin");
  assert.equal(classify("https://sg.jobstreet.com/job/1").key, "jobstreet");
  assert.equal(classify("https://jobs.careers.gov.sg/jobs/1").key, "careersgov");
  assert.equal(classify("https://tenant.myworkdayjobs.com/apply").key, "application");
  assert.equal(classify("https://tenant.successfactors.eu/apply").key, "application");
  assert.equal(classify("https://tenant.jobs.hr.cloud.sap.com/apply").key, "application");
  assert.equal(classify("https://example.com").key, "other");
});

test("only the root worker owns global hotkeys", () => {
  const rootWorker = fs.readFileSync(path.join(root, "service-worker.js"), "utf8");
  assert.match(rootWorker, /chrome\.commands\.onCommand\.addListener/);
  for (const site of ["linkedin", "jobstreet", "careersgov"]) {
    const worker = fs.readFileSync(path.join(root, "sites", site, "worker.js"), "utf8");
    assert.doesNotMatch(worker, /chrome\.commands\.onCommand\.addListener/);
  }
});
