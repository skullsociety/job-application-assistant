"use strict";
importScripts('successfactors-core.js');
(() => {
  const PROFILE_URL = 'http://127.0.0.1:8767/api/autofill-profile';
  function timeout(promise, milliseconds, message) {
    return Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error(message)), milliseconds))]);
  }
  async function fetchProfile(options) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetch(PROFILE_URL, {cache: 'no-store', signal: controller.signal, ...options,
        headers: {'X-Job-Assistant-Extension': chrome.runtime.id, ...(options.headers || {})}});
      const value = await response.json();
      if (!response.ok || !value.ok) throw new Error(value.error || 'The autofill profile could not be loaded.');
      return value;
    } finally { clearTimeout(timer); }
  }
  function editor(sender) { return sender.url?.split('?')[0] === chrome.runtime.getURL('autofill-profile.html'); }
  async function request(options = {}) {
    if (options.method === 'POST') {
      // Check connectivity first. A timed-out POST may already have committed,
      // so never silently send the same full-profile replacement twice.
      try { await fetchProfile(); }
      catch {
        if (!globalThis.JobAssistantLifecycle?.start) throw new Error('Reload this extension after running the suite setup.');
        await timeout(globalThis.JobAssistantLifecycle.start(), 12000, 'The Chrome helper did not start within 12 seconds. Run the suite setup and reload this extension.');
      }
      return fetchProfile(options);
    }
    try {
      return await fetchProfile(options);
    } catch {
      if (!globalThis.JobAssistantLifecycle?.start) throw new Error('Reload this extension after running the suite setup.');
      await timeout(globalThis.JobAssistantLifecycle.start(), 12000, 'The Chrome helper did not start within 12 seconds. Run the suite setup and reload this extension.');
      return fetchProfile(options);
    }
  }
  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (!['GET_SF_PROFILE','SAVE_SF_PROFILE','OPEN_SF_PROFILE'].includes(message?.type)) return false;
    const isEditor = editor(sender);
    let isForm = false;
    try { isForm = SuccessFactorsCore.supported(new URL(sender.url || sender.tab?.url).hostname); } catch {}
    const isPanel = sender.url === chrome.runtime.getURL('sidepanel.html')
      || /^sites\/(linkedin|jobstreet|careersgov)\/sidepanel\.html$/.test(String(sender.url || '').replace(chrome.runtime.getURL(''), ''));
    if (!isEditor && !isForm && !isPanel) { respond({ok: false, error: 'Use a supported Workday/SuccessFactors form or the extension profile.'}); return false; }
    if (message.type === 'SAVE_SF_PROFILE' && !isEditor) { respond({ok: false, error: 'Only the profile editor can change defaults.'}); return false; }
    if (message.type === 'OPEN_SF_PROFILE') {
      chrome.tabs.create({url: chrome.runtime.getURL('autofill-profile.html')}).then(() => respond({ok: true}));
    } else {
      request(message.type === 'SAVE_SF_PROFILE' ? {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(message.value)} : {})
        .then(respond).catch(error => respond({ok: false, error: error.message}));
    }
    return true;
  });
})();
