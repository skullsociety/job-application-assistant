const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");
const core = require("./capture-core.js");

test("canonical URL and safe link rules", () => {
  assert.equal(core.canonicalUrl("https://jobs.careers.gov.sg/jobs/hrp/123/abc?track=1#top"), "https://jobs.careers.gov.sg/jobs/hrp/123/abc");
  for (const url of ["https://evil.invalid/jobs/hrp/123", "https://jobs.careers.gov.sg/"]) assert.throws(() => core.canonicalUrl(url));
  assert.equal(core.httpUrl("javascript:alert(1)", "https://jobs.careers.gov.sg"), "");
  assert.equal(core.httpUrl("https://a:b@example.com", "https://jobs.careers.gov.sg"), "");
});
test("metadata maps into the LinkedIn/JobStreet capture contract without guessed facts", () => {
  const job = core.metadata({
    hiringOrganization: {name: "Agency", sameAs: "https://example.com"},
    jobLocation: {address: {addressLocality: "Singapore", addressCountry: "SG"}},
    baseSalary: {currency: "SGD", value: {minValue: 5000, maxValue: 7000, unitText: "MONTH"}},
    datePosted: "2026-09-01", validThrough: "2026-09-30", employmentType: ["FULL_TIME", "CONTRACT"],
  }, "https://jobs.careers.gov.sg/jobs/hrp/123");
  assert.equal(job.company, "Agency");
  assert.equal(job.location, "Singapore, SG");
  assert.equal(job.salary, "SGD 5000–7000 MONTH");
  assert.equal(job.posting_date, "2026-09-01");
  assert.equal(core.metadata().salary, "");
  assert.equal(core.metadata().location, "");
});
test("side panel bindings and shared application autofill files exist", () => {
  const script = fs.readFileSync(path.join(__dirname, "sidepanel.js"), "utf8");
  const html = fs.readFileSync(path.join(__dirname, "sidepanel.html"), "utf8");
  for (const match of script.matchAll(/document\.querySelector\("#([^"]+)"\)/g)) assert.ok(html.includes('id="' + match[1] + '"'), match[1]);
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "..", "manifest.json"), "utf8"));
  assert.deepEqual(manifest.content_scripts[2].js, ["sites/careersgov/capture-core.js", "sites/careersgov/content.js"]);
  assert.deepEqual(manifest.content_scripts[3].js, ["successfactors-core.js", "successfactors-autofill.js"]);
  assert.ok(manifest.content_scripts[3].matches.includes("https://*.myworkdayjobs.com/*"));
  assert.ok(!manifest.host_permissions.includes("<all_urls>"));
});
function mockPage() {
  let listener;
  let description = "Build Python and SQL pipelines with validation controls.";
  const article = {tagName: "ARTICLE", get textContent() { return description; }};
  const title = {textContent: "Data Analyst", previousElementSibling: {tagName:"P", textContent:"Agency"}, parentElement: {textContent:"Data Analyst Permanent Closing on 30 Sep 2026"}};
  const heading = {textContent:"What the role is", parentElement:{children:[article]}};
  const document = {
    hidden:false, documentElement:{},
    querySelector: selector => selector === "h1" ? title : null,
    querySelectorAll: selector => selector === "h2" ? [heading] : [],
    addEventListener() {},
  };
  const context = {
    CareersGovCaptureCore:core, URL, console, document, window:{location:{href:"https://jobs.careers.gov.sg/jobs/hrp/123"}},
    setTimeout:()=>1, clearTimeout(){}, setInterval(){},
    MutationObserver:class {observe(){}},
    chrome:{runtime:{onMessage:{addListener(value){listener=value;}}}, storage:{local:{get:async()=>({careersGovAutoCapture:false})},onChanged:{addListener(){}}}},
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "content.js"), "utf8"), context);
  return {
    setDescription(value) {description=value;},
    extract() {let result; listener({type:"EXTRACT_JOB"}, {}, value=>{result=value;}); return result;},
  };
}
test("visible extraction exposes shared fields and does not reuse stale same-URL description", () => {
  const page = mockPage();
  const first = page.extract();
  assert.equal(first.ok,true);
  assert.equal(first.job.platform,"Careers@Gov");
  assert.equal(first.job.source,"careersgov");
  assert.equal(first.job.description,first.job.job_description);
  assert.equal(first.job.company,"Agency");
  assert.equal(first.job.employment_type,"Permanent");
  assert.equal(first.job.closing_date,"Closing on 30 Sep 2026");
  assert.equal(first.job.location,"");
  page.setDescription("A changed description with Power BI and Python development.");
  assert.notEqual(page.extract().job.job_description,first.job.job_description);
  page.setDescription("");
  assert.equal(page.extract().ok,false);
});
