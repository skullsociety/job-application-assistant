"use strict";
// Starts only the real job assistants, verifies their common data, then releases
// the native connection just as Chrome does. Does not open or close Chrome.
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const {spawn} = require("node:child_process");
const {SERVICES, health} = require("./supervisor.js");

async function main() {
  const preexisting = (await Promise.all(SERVICES.map(async s => await health(s) ? s.folder : null))).filter(Boolean);
  if (preexisting.length) throw new Error("Close old assistant services before this smoke test: " + preexisting.join(", "));
  const native = spawn(process.execPath, [path.join(__dirname, "native-host.js")], {windowsHide: true, stdio: ["pipe", "pipe", "pipe"]});
  try {
    const ready = new Promise((resolve, reject) => {
      let input = Buffer.alloc(0);
      const timeout = setTimeout(() => reject(new Error("Native startup timed out.")), 90000);
      native.stdout.on("data", chunk => {
        input = Buffer.concat([input, chunk]);
        if (input.length < 4 || input.length < 4 + input.readUInt32LE(0)) return;
        clearTimeout(timeout); resolve(JSON.parse(input.subarray(4, 4 + input.readUInt32LE(0)).toString()));
      });
      native.on("error", reject);
      native.on("exit", code => { if (input.length < 4) { clearTimeout(timeout); reject(new Error("Native host exited: " + code)); } });
    });
    const body = Buffer.from('{"action":"start"}'), header = Buffer.alloc(4); header.writeUInt32LE(body.length);
    native.stdin.write(Buffer.concat([header, body]));
    const status = await ready;
    assert.ok(status.ok, status.error);
    assert.deepEqual(status.external, []);
    const jobs = await (await fetch("http://127.0.0.1:8767/api/jobs")).json();
    const sources = {};
    for (const job of jobs.jobs) sources[job.source] = (sources[job.source] || 0) + 1;
    assert.ok(sources.careersgov && sources.linkedin && sources.jobstreet);
    const cg = await (await fetch("http://127.0.0.1:8765/api/jobs")).json();
    assert.equal(cg.jobs.length, sources.careersgov);
    const li = await (await fetch("http://127.0.0.1:8766/api/jobs")).json();
    assert.equal(li.jobs.length, jobs.jobs.length);
    const html = await (await fetch("http://127.0.0.1:8767/")).text();
    assert.ok(html.includes("Unified Job Application Dashboard") && html.includes("Careers@Gov"));
    assert.ok(!html.includes('follow-up-select'));
    const registration = JSON.parse(fs.readFileSync(path.join(__dirname, 'generated/com.job_application_assistant.launcher.json')));
    for (const allowed of registration.allowed_origins) {
      const response = await fetch('http://127.0.0.1:8767/api/autofill-profile', {headers:{Origin:allowed.replace(/\/$/, '')}});
      assert.equal(response.status, 200);
      const data = await response.json();
      assert.ok(data.ok && Array.isArray(data.profile.education) && Array.isArray(data.profile.employment));
    }
    assert.equal((await fetch('http://127.0.0.1:8767/api/autofill-profile')).status, 403);
    const pdfJob = jobs.jobs.find(job => job.source === "careersgov" && job.tailored_resume_path);
    if (pdfJob) {
      const pdf = await fetch(`http://127.0.0.1:8767/api/jobs/${pdfJob.id}/resume`);
      assert.equal(pdf.status, 200);
      assert.ok((await pdf.text()).startsWith("%PDF"));
    }
    const excel = await fetch("http://127.0.0.1:8767/exports/job_tracker.xlsx");
    assert.equal(excel.status, 200);
    await excel.arrayBuffer();
    console.log(JSON.stringify({native_startup: "passed", common_dashboard: "passed", total: jobs.jobs.length, sources, excel: "passed", careersgov_resume_link: pdfJob ? "passed" : "not available"}));
  } finally {
    native.stdin.end();
    let stopped = false;
    for (let attempt = 0; attempt < 50; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 300));
      if (!(await Promise.all(SERVICES.map(health))).some(Boolean)) {
        console.log("Last native connection closed: all three owned assistant services stopped.");
        stopped = true;
        break;
      }
    }
    if (!stopped) throw new Error("One or more assistants stayed online; Chrome may have reconnected during the shutdown test.");
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
