(() => {
  "use strict";
  if (globalThis.__jobStreetJobAssistantLoaded) return;
  globalThis.__jobStreetJobAssistantLoaded = true;

  let autoCaptureEnabled = true;
  let autoCaptureUrl = "";
  let scheduledCapture = 0;

  const clean = (value) => String(value || "").replace(/\s+/g, " ").trim();
  const visible = (element) => Boolean(
    element
    && element.getClientRects().length
    && getComputedStyle(element).visibility !== "hidden"
    && getComputedStyle(element).display !== "none"
  );
  const visibleText = (element) => visible(element) ? clean(element.innerText || element.textContent) : "";

  function isJobStreetHostname(hostname) {
    const normalized = clean(hostname).toLowerCase().replace(/\.$/, "");
    return /^(?:[a-z0-9-]+\.)*jobstreet\.com(?:\.[a-z]{2})?$/.test(normalized);
  }

  function jobStreetJobId(value) {
    try {
      const url = new URL(value || "", location.href);
      if (!isJobStreetHostname(url.hostname)) return "";
      const pathId = url.pathname.match(/(?:^|\/)job\/(\d+)(?:\/|$)/i)?.[1] || "";
      const queryId = url.searchParams.get("jobId") || "";
      const id = pathId || queryId;
      return /^\d+$/.test(id) ? id : "";
    } catch (_error) {
      return "";
    }
  }

  function canonicalJobUrl(value = location.href) {
    const id = jobStreetJobId(value);
    if (!id) return "";
    const url = new URL(value, location.href);
    return `https://${url.hostname.toLowerCase()}/job/${id}`;
  }

  function findJobPosting(value) {
    if (Array.isArray(value)) {
      for (const item of value) {
        const found = findJobPosting(item);
        if (found) return found;
      }
      return null;
    }
    if (!value || typeof value !== "object") return null;
    const types = Array.isArray(value["@type"]) ? value["@type"] : [value["@type"]];
    if (types.some((type) => clean(type).toLowerCase() === "jobposting")) return value;
    return findJobPosting(value["@graph"]);
  }

  function structuredJobPosting() {
    for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
      try {
        const found = findJobPosting(JSON.parse(script.textContent || "null"));
        if (found) return found;
      } catch (_error) {
        // Ignore unrelated or incomplete structured-data blocks while the page renders.
      }
    }
    return {};
  }

  function htmlToText(value) {
    if (!value) return "";
    const parsed = new DOMParser().parseFromString(String(value), "text/html");
    parsed.querySelectorAll("script, style, noscript").forEach((element) => element.remove());
    parsed.querySelectorAll("br").forEach((element) => element.replaceWith("\n"));
    parsed.querySelectorAll("p, li, h1, h2, h3, h4, h5, h6").forEach((element) => element.append("\n"));
    return (parsed.body.textContent || "")
      .split(/\n+/)
      .map(clean)
      .filter(Boolean)
      .join("\n");
  }

  function firstVisibleText(selectors, root = document) {
    for (const selector of selectors) {
      for (const element of root.querySelectorAll(selector)) {
        const value = visibleText(element);
        if (value) return value;
      }
    }
    return "";
  }

  function selectedJobCard(jobId) {
    if (!/^\d+$/.test(jobId)) return null;
    return document.querySelector(`article[data-job-id="${jobId}"][aria-selected="true"]`)
      || document.querySelector(`article[data-job-id="${jobId}"]`);
  }

  function splitViewDetailsMatch(jobId, root) {
    if (!new URL(location.href).searchParams.has("jobId")) return true;
    return [...root.querySelectorAll('[data-automation="job-detail-title"] a[href], [data-automation="job-detail-apply"][href]')]
      .some((link) => jobStreetJobId(link.href) === jobId);
  }

  function selectedCardSalary(card) {
    if (!card) return "";
    const salary = [...card.querySelectorAll("[aria-label]")]
      .find((element) => /^salary\s*:/i.test(clean(element.getAttribute("aria-label"))));
    return clean(salary?.getAttribute("aria-label")).replace(/^salary\s*:\s*/i, "");
  }

  function selectedCardEmploymentType(card) {
    return clean(card?.innerText).match(/\bThis is an?\s+(.+?)\s+job\b/i)?.[1] || "";
  }

  function firstHttpLink(selectors, root = document) {
    for (const selector of selectors) {
      const link = root.querySelector(selector);
      const url = safeHttpUrl(link?.getAttribute("href"));
      if (url) return { url, text: visibleText(link) };
    }
    return { url: "", text: "" };
  }

  function safeHttpUrl(value) {
    try {
      const url = new URL(value || "", location.href);
      return ["http:", "https:"].includes(url.protocol) ? url.href : "";
    } catch (_error) {
      return "";
    }
  }

  function structuredLocation(jobPosting) {
    const places = Array.isArray(jobPosting.jobLocation) ? jobPosting.jobLocation : [jobPosting.jobLocation];
    const address = places.find(Boolean)?.address || {};
    const country = typeof address.addressCountry === "object" ? address.addressCountry.name : address.addressCountry;
    return [address.addressLocality, address.addressRegion, country].map(clean).filter(Boolean).join(", ");
  }

  function structuredEmploymentType(jobPosting) {
    const values = Array.isArray(jobPosting.employmentType) ? jobPosting.employmentType : [jobPosting.employmentType];
    return values.filter(Boolean).map((value) => clean(value).replace(/[_-]+/g, " ").toLowerCase())
      .map((value) => value.replace(/^./, (letter) => letter.toUpperCase())).join(", ");
  }

  function structuredSalary(jobPosting) {
    const salary = jobPosting.baseSalary;
    const value = salary?.value || {};
    const minimum = value.minValue ?? value.value;
    const maximum = value.maxValue;
    if (minimum === undefined || minimum === null) return "";
    const currency = clean(salary.currency);
    const range = maximum === undefined || maximum === null ? `${minimum}` : `${minimum} - ${maximum}`;
    const unit = clean(value.unitText).replace(/_/g, " ").toLowerCase();
    return clean(`${currency} ${range}${unit ? ` per ${unit}` : ""}`);
  }

  function extractJob() {
    const url = canonicalJobUrl();
    if (!url) throw new Error("Open a full JobStreet job-detail page before capturing.");
    const jobId = jobStreetJobId(location.href);

    const pageText = clean(document.body?.innerText || "");
    if (/(security verification|verify your identity|unusual activity|captcha|robot check)/i.test(pageText)) {
      throw new Error("JobStreet is asking for verification. Complete it manually; the assistant will not interact with it.");
    }

    const pageRoot = document.querySelector('[data-automation="jobDetailsPage"]') || document;
    if (!splitViewDetailsMatch(jobId, pageRoot)) {
      throw new Error("The selected JobStreet job is still loading. Wait for its detail panel to update.");
    }
    const selectedCard = selectedJobCard(jobId);
    const structured = structuredJobPosting();
    const title = firstVisibleText(['[data-automation="job-detail-title"]', "main h1"], pageRoot)
      || firstVisibleText(['[data-automation="jobTitle"]'], selectedCard || document)
      || clean(structured.title);
    const company = firstVisibleText(['[data-automation="advertiser-name"]'], pageRoot)
      || firstVisibleText(['[data-automation="jobCompany"]'], selectedCard || document)
      || clean(structured.hiringOrganization?.name);
    const locationText = firstVisibleText(['[data-automation="job-detail-location"]'], pageRoot)
      || firstVisibleText(['[data-automation="jobLocation"]'], selectedCard || document)
      || structuredLocation(structured);
    const salary = firstVisibleText(['[data-automation="job-detail-salary"]'], pageRoot)
      || selectedCardSalary(selectedCard)
      || structuredSalary(structured);
    const employmentType = firstVisibleText(['[data-automation="job-detail-work-type"]'], pageRoot)
      || selectedCardEmploymentType(selectedCard)
      || structuredEmploymentType(structured);
    const description = htmlToText(structured.description)
      || firstVisibleText(['[data-automation="jobAdDetails"]'], pageRoot);
    const pageDetailsText = pageRoot === document ? pageText : visibleText(pageRoot);
    const workplaceType = firstVisibleText([
      '[data-automation="job-detail-work-arrangement"]',
      '[data-automation*="workplace"]',
    ], pageRoot)
      || clean(selectedCard?.innerText).match(/\b(?:On-site|Hybrid|Remote)\b/i)?.[0]
      || (clean(structured.jobLocationType).toUpperCase() === "TELECOMMUTE" ? "Remote" : "");
    const postingDate = clean(structured.datePosted)
      || pageDetailsText.match(/\bPosted\s+\d+\s*(?:m|h|d|w|mo)\s+ago\b/i)?.[0]
      || firstVisibleText(['[data-automation="jobListingDate"]'], selectedCard || document)
      || "";
    const applicantCount = pageDetailsText.match(/\b(?:Low|Medium|High)\s+application volume\b/i)?.[0] || "";
    const companyLink = firstHttpLink(['[data-testid="job-card-company-logo-link"]'], selectedCard || document);
    const applicationLink = firstHttpLink(['[data-automation="job-detail-apply"]'], pageRoot);

    if (!title || !company) throw new Error("The job title or company is not visible yet. Wait for the listing to finish loading.");
    if (!description || description.length < 80) throw new Error("The complete job description is not available yet. Wait for the listing to finish loading.");

    return {
      title,
      company,
      url,
      company_url: safeHttpUrl(structured.hiringOrganization?.sameAs) || companyLink.url,
      application_url: applicationLink.url,
      application_method: applicationLink.text || (structured.directApply === true ? "JobStreet direct apply" : ""),
      location: locationText,
      salary,
      workplace_type: workplaceType,
      employment_type: employmentType,
      seniority_level: "",
      applicant_count: applicantCount,
      posting_date: postingDate,
      closing_date: clean(structured.validThrough),
      job_description: description,
    };
  }

  function showStatus(message, kind = "pending") {
    let toast = document.querySelector("#jobstreet-job-assistant-toast");
    if (!toast) {
      toast = document.createElement("div");
      toast.id = "jobstreet-job-assistant-toast";
      toast.setAttribute("role", "status");
      toast.style.cssText = "position:fixed;right:24px;bottom:24px;z-index:2147483647;max-width:360px;padding:13px 17px;border-radius:12px;color:#fff;font:600 14px/1.4 Segoe UI,sans-serif;box-shadow:0 12px 32px rgba(0,0,0,.25)";
      document.documentElement.appendChild(toast);
    }
    toast.textContent = message;
    toast.style.background = kind === "success" ? "#087a55" : kind === "error" ? "#b42318" : "#1f6795";
    toast.style.display = "block";
    clearTimeout(globalThis.__jobStreetAssistantToast);
    globalThis.__jobStreetAssistantToast = setTimeout(() => { toast.style.display = "none"; }, kind === "error" ? 6500 : 4000);
  }

  function scheduleAutoCapture() {
    clearTimeout(scheduledCapture);
    scheduledCapture = setTimeout(async () => {
      if (!autoCaptureEnabled) return;
      const url = canonicalJobUrl();
      if (!url || url === autoCaptureUrl) return;
      try {
        extractJob();
        autoCaptureUrl = url;
        showStatus("Capturing this visible JobStreet listing locally…");
        const response = await chrome.runtime.sendMessage({ type: "AUTO_CAPTURE_JOBSTREET_JOB" });
        if (!response?.ok) {
          autoCaptureUrl = "";
          showStatus(response?.error || "The visible job could not be captured.", "error");
        }
      } catch (_error) {
        // A JobStreet page can be incomplete while its client-side navigation renders.
      }
    }, 700);
  }

  async function initialize() {
    try {
      const response = await chrome.runtime.sendMessage({ type: "GET_JOBSTREET_SETTINGS" });
      if (response?.ok) autoCaptureEnabled = response.autoCapture !== false;
    } catch (_error) {
      // If Chrome is still starting the extension, the editable side panel remains available.
    }
    scheduleAutoCapture();
  }

  initialize();
  new MutationObserver(scheduleAutoCapture).observe(document.documentElement, { childList: true, subtree: true });
  addEventListener("popstate", scheduleAutoCapture);

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    try {
      if (message?.type === "EXTRACT_JOBSTREET_JOB") {
        sendResponse({ ok: true, job: extractJob() });
        return false;
      }
      if (message?.type === "SHOW_JOBSTREET_STATUS") {
        showStatus(String(message.message || ""), message.kind || "pending");
        sendResponse({ ok: true });
        return false;
      }
      if (message?.type === "JOBSTREET_SETTINGS_UPDATED") {
        autoCaptureEnabled = message.autoCapture !== false;
        if (!autoCaptureEnabled) autoCaptureUrl = "";
        scheduleAutoCapture();
        sendResponse({ ok: true });
        return false;
      }
    } catch (error) {
      sendResponse({ ok: false, error: error.message });
      return false;
    }
    return false;
  });
})();
