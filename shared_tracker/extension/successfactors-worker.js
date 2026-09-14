"use strict";
importScripts('successfactors-core.js');
(() => {
  const PROFILE_URL = 'http://127.0.0.1:8767/api/autofill-profile';
  function editor(sender) { return sender.url?.split('?')[0] === chrome.runtime.getURL('autofill-profile.html'); }
  async function request(options = {}) {
    try {
      const response = await fetch(PROFILE_URL, {cache: 'no-store', ...options});
      const value = await response.json();
      if (!response.ok || !value.ok) throw new Error(value.error || 'The autofill profile could not be loaded.');
      return value;
    } catch (error) {
      if (!(error instanceof TypeError)) throw error;
      await globalThis.JobAssistantLifecycle.start();
      const response = await fetch(PROFILE_URL, {cache: 'no-store', ...options});
      const value = await response.json();
      if (!response.ok || !value.ok) throw new Error(value.error || 'Profile unavailable.');
      return value;
    }
  }
  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (!['GET_SF_PROFILE','SAVE_SF_PROFILE','OPEN_SF_PROFILE'].includes(message?.type)) return false;
    const isEditor = editor(sender);
    let isForm = false;
    try { isForm = SuccessFactorsCore.supported(new URL(sender.url || sender.tab?.url).hostname); } catch {}
    const isPanel = sender.url === chrome.runtime.getURL('sidepanel.html');
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
