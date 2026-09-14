(function installCaptureCore(root) {
  "use strict";
  const clean = value => String(value ?? "").replace(/\s+/g, " ").trim();
  function canonicalUrl(value) {
    const url = new URL(value);
    if (url.origin !== "https://jobs.careers.gov.sg" || !/^\/jobs\/[^/]+\/[^/]+/.test(url.pathname)) {
      throw new Error("Open a full Careers@Gov job-detail page.");
    }
    url.search = ""; url.hash = "";
    return url.toString().replace(/\/$/, "");
  }
  function httpUrl(value, base) {
    if (!value) return "";
    try {
      const url = new URL(value, base);
      return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password ? url.href : "";
    } catch (_) { return ""; }
  }
  function metadata(posting = {}, url) {
    const organization = posting.hiringOrganization || {};
    const locations = Array.isArray(posting.jobLocation) ? posting.jobLocation : [posting.jobLocation];
    const location = locations.filter(Boolean).map(place => {
      const address = place.address || {};
      if (typeof address === "string") return clean(address);
      return [...new Set([address.addressLocality, address.addressRegion, address.addressCountry?.name || address.addressCountry].filter(Boolean))].join(", ");
    }).join("; ");
    const salary = posting.baseSalary;
    let salaryText = "";
    if (salary && typeof salary === "object") {
      const value = salary.value;
      if (typeof value === "number") salaryText = [salary.currency, value].filter(Boolean).join(" ");
      else if (value && typeof value === "object") {
        const amount = value.value ?? (value.minValue != null && value.maxValue != null ? value.minValue + "–" + value.maxValue : value.minValue ?? value.maxValue);
        if (amount != null) salaryText = [salary.currency, amount, value.unitText].filter(Boolean).join(" ");
      }
    }
    return {
      title: clean(posting.title), company: clean(organization.name), location, salary: salaryText,
      company_url: httpUrl(organization.sameAs || organization.url, url),
      employment_type: clean(Array.isArray(posting.employmentType) ? posting.employmentType.join(", ") : posting.employmentType),
      workplace_type: posting.jobLocationType === "TELECOMMUTE" ? "Remote" : "",
      posting_date: clean(posting.datePosted), closing_date: clean(posting.validThrough),
    };
  }
  root.CareersGovCaptureCore = {clean, canonicalUrl, httpUrl, metadata};
  if (typeof module !== "undefined") module.exports = root.CareersGovCaptureCore;
})(globalThis);
