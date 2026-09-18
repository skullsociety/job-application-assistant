(() => {
  if (globalThis.__careersGovAssistantLoaded) return;
  globalThis.__careersGovAssistantLoaded = true;

  const core = globalThis.CareersGovCaptureCore;
  const clean = core.clean;
  const AUTO_CAPTURE_KEY = "careersGovAutoCapture";
  let autoCapture = true;
  let autoTimer;
  let autoRunning = false;
  let lastSavedSignature = "";
  let retryAfter = 0;

  function showCaptureStatus(message, kind = "pending") {
    const toastId = "careersgov-assistant-toast";
    let toast = document.getElementById(toastId);
    if (!toast) {
      toast = document.createElement("div");
      toast.id = toastId;
      toast.setAttribute("role", "status");
      toast.style.cssText = [
        "position:fixed",
        "right:24px",
        "bottom:24px",
        "z-index:2147483647",
        "max-width:360px",
        "padding:13px 17px",
        "border-radius:12px",
        "color:#fff",
        "font:600 14px/1.4 'Segoe UI',sans-serif",
        "box-shadow:0 12px 32px rgba(0,0,0,.25)",
      ].join(";");
      document.documentElement.appendChild(toast);
    }
    toast.textContent = message;
    toast.style.background = kind === "success" ? "#227B52" : kind === "error" ? "#B32F43" : "#8B2858";
    toast.style.display = "block";
    clearTimeout(globalThis.__careersGovToastTimer);
    globalThis.__careersGovToastTimer = setTimeout(() => {
      toast.style.display = "none";
    }, kind === "error" ? 6000 : 3500);
  }

  function previousParagraph(element) {
    let candidate = element?.previousElementSibling;
    while (candidate) {
      if (candidate.tagName === "P" && clean(candidate.textContent)) return clean(candidate.textContent);
      candidate = candidate.previousElementSibling;
    }
    return "";
  }

  function sectionText(name) {
    const heading = [...document.querySelectorAll("h2")].find((item) => clean(item.textContent) === name);
    if (!heading) return "";
    const directArticle = [...(heading.parentElement?.children || [])].find((item) => item.tagName === "ARTICLE");
    const article = directArticle || (heading.nextElementSibling?.tagName === "ARTICLE" ? heading.nextElementSibling : null);
    return clean(article?.textContent);
  }

  function extractJob() {
    const currentUrl = core.canonicalUrl(window.location.href);
    const metadata = core.metadata(jobPosting(currentUrl), currentUrl);
    const titleElement = document.querySelector("h1");
    const title = clean(titleElement?.textContent);
    const breadcrumbCompany = clean(document.querySelector("nav[aria-label='breadcrumb'] [aria-current='page']")?.textContent);
    const company = previousParagraph(titleElement) || breadcrumbCompany || metadata.company;
    if (!title || !company) {
      throw new Error("Open a fully loaded Careers@Gov job-detail page before capturing.");
    }

    const headerText = clean(titleElement.parentElement?.textContent);
    const employmentTypes = ["Permanent/Contract", "Fixed Terms", "Permanent", "Contract", "Internship", "Temporary"];
    const employmentType = employmentTypes.find((value) => headerText.includes(value)) || "";
    const closingDate = headerText.match(/Closing on\s+\d{1,2}\s+[A-Za-z]{3}\s+\d{4}/i)?.[0] || "";
    const sectionNames = ["What the role is", "What you will be working on", "What we are looking for"];
    let description = sectionNames
      .map((name) => ({ name, text: sectionText(name) }))
      .filter((section) => section.text)
      .map((section) => `${section.name}\n${section.text}`)
      .join("\n\n");
    if (!description) {
      const articles = [...document.querySelectorAll("main article")]
        .map((article) => clean(article.textContent))
        .filter((text) => text.length > 100);
      description = articles.sort((left, right) => right.length - left.length)[0] || "";
    }

    if (!description || description.length < 30) throw new Error("Wait for the complete job description before capturing.");
    const applyLink = [...document.querySelectorAll("main a[href]")].find(anchor => /^apply(?: now| for this job)?$/i.test(clean(anchor.textContent)));
    return {
      ...metadata,
      source: "careersgov",
      platform: "Careers@Gov",
      url: currentUrl,
      title,
      company,
      location: labelledValue("Location") || metadata.location,
      salary: labelledValue("Salary") || metadata.salary,
      workplace_type: labelledValue("Work arrangement") || metadata.workplace_type,
      employment_type: employmentType || metadata.employment_type,
      closing_date: closingDate || metadata.closing_date,
      application_url: core.httpUrl(applyLink?.getAttribute("href"), currentUrl),
      application_method: applyLink ? "External application" : "",
      job_description: description,
      description,
    };
  }

  function labelledValue(label) {
    // Only labelled facts, never a guessed Singapore location or salary.
    const candidates = [...document.querySelectorAll("main dt, main label, main strong")];
    const node = candidates.find(item => clean(item.textContent).replace(/:$/, "").toLowerCase() === label.toLowerCase());
    return clean(node?.nextElementSibling?.textContent);
  }

  function jobPosting(url) {
    const postings = [];
    function collect(value) {
      if (Array.isArray(value)) return value.forEach(collect);
      if (!value || typeof value !== "object") return;
      if ([value["@type"]].flat().includes("JobPosting")) postings.push(value);
      if (value["@graph"]) collect(value["@graph"]);
    }
    for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
      try { collect(JSON.parse(script.textContent)); } catch (_) {}
    }
    return postings.find(posting => {
      try { return core.canonicalUrl(posting.url || url) === url && (posting.url || postings.length === 1); } catch (_) { return false; }
    }) || {};
  }

  async function captureVisibleJob() {
    if (!autoCapture || autoRunning || document.hidden || Date.now() < retryAfter) return;
    try {
      const job = extractJob();
      const signature = JSON.stringify(job);
      if (signature === lastSavedSignature) return;
      autoRunning = true;
      const response = await chrome.runtime.sendMessage({type: "AUTO_CAPTURE_CAREERSGOV_JOB", job});
      if (!response?.ok) { retryAfter = Date.now() + 15000; return; }
      lastSavedSignature = signature;
      showCaptureStatus("Captured job #" + response.body.job.id + ". Analysis is updating.", "success");
    } catch (_) {
      // Incomplete pages are retried on the next DOM change, not captured as blank jobs.
    } finally { autoRunning = false; }
  }
  function scheduleCapture() {
    clearTimeout(autoTimer);
    autoTimer = setTimeout(captureVisibleJob, 900);
  }
  chrome.storage.local.get(AUTO_CAPTURE_KEY).then(stored => {
    autoCapture = stored[AUTO_CAPTURE_KEY] !== false;
    scheduleCapture();
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes[AUTO_CAPTURE_KEY]) {
      autoCapture = changes[AUTO_CAPTURE_KEY].newValue !== false;
      scheduleCapture();
    }
  });
  new MutationObserver(scheduleCapture).observe(document.documentElement, {childList: true, subtree: true, characterData: true});
  document.addEventListener("visibilitychange", scheduleCapture);
  setInterval(scheduleCapture, 15000);

  function jobLinksOnPage() {
    const links = [];
    const seen = new Set();
    for (const anchor of document.querySelectorAll("a[href]")) {
      try {
        const url = new URL(anchor.href, window.location.href);
        const parts = url.pathname.split("/").filter(Boolean);
        if (url.origin !== "https://jobs.careers.gov.sg" || parts[0] !== "jobs" || parts.length < 3) continue;
        url.search = "";
        url.hash = "";
        const canonical = url.toString();
        if (!seen.has(canonical)) {
          seen.add(canonical);
          links.push(canonical);
        }
      } catch (_error) {
        // Ignore malformed or non-web links.
      }
    }
    return links;
  }

  async function handleBatchHotkey(action) {
    try {
      if (action === "open") {
        const urls = jobLinksOnPage();
        if (!urls.length) throw new Error("No Careers@Gov job links were found on this page.");
        showCaptureStatus(`Opening ${urls.length} job listing${urls.length === 1 ? "" : "s"}…`, "pending");
        const response = await chrome.runtime.sendMessage({ type: "OPEN_PAGE_JOB_LINKS", urls });
        if (!response?.ok) throw new Error(response?.error || "The job tabs could not be opened.");
        const caution = response.opened > 12 ? " Run Ctrl+] now to reduce the chance of a Careers@Gov 403 session error." : "";
        showCaptureStatus(`Opened ${response.opened} job tab${response.opened === 1 ? "" : "s"}. Press Ctrl+] to capture and close them.${caution}`, "success");
        return;
      }
      showCaptureStatus("Starting queued job capture…", "pending");
      const response = await chrome.runtime.sendMessage({ type: "CAPTURE_OPENED_JOB_TABS" });
      if (!response?.ok) throw new Error(response?.error || "The queued tabs could not be captured.");
    } catch (error) {
      showCaptureStatus(error.message, "error");
    }
  }

  document.addEventListener("keydown", (event) => {
    const target = event.target;
    if (event.repeat || event.altKey || event.metaKey || event.shiftKey || !event.ctrlKey) return;
    if (target?.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target?.tagName)) return;
    const action = event.code === "BracketLeft" ? "open" : event.code === "BracketRight" ? "capture" : "";
    if (!action) return;
    event.preventDefault();
    event.stopPropagation();
    handleBatchHotkey(action);
  }, true);

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "SHOW_CAPTURE_STATUS") {
      showCaptureStatus(String(message.message || ""), message.kind);
      sendResponse({ ok: true });
      return false;
    }
    if (message?.type !== "EXTRACT_JOB") return false;
    try {
      sendResponse({ ok: true, job: extractJob() });
    } catch (error) {
      sendResponse({ ok: false, error: error.message });
    }
    return false;
  });
})();
