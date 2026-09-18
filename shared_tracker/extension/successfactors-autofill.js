"use strict";
(() => {
  const core = globalThis.SuccessFactorsCore;
  if (!core?.supported(location.hostname) || globalThis.__successFactorsAssistantLoaded) return;
  globalThis.__successFactorsAssistantLoaded = true;
  const OWNER = 'data-job-assistant-application-owner';
  const mine = chrome.runtime.id;
  let running = false, scheduled, profile, fetchedAt = 0, dismissed = false, profileRevision = '';
  let attemptedSkills = new WeakMap();
  let failedDropdowns = new Set();
  const userEdited = new WeakSet(), additions = new WeakSet();
  const visible = el => !!(el && el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden');
  const text = el => el?.innerText || el?.textContent || '';
  const controls = () => [...document.querySelectorAll('input,textarea,select,[role="combobox"],button[aria-haspopup="listbox"]')]
    .filter(el => visible(el) && !el.disabled && !el.readOnly && !el.closest('#job-assistant-sf-status'));
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  function owner(force = false) {
    let current;
    try { current = JSON.parse(document.documentElement.getAttribute(OWNER) || 'null'); } catch {}
    if (!force && current && current.id !== mine && current.until > Date.now()) return false;
    document.documentElement.setAttribute(OWNER, JSON.stringify({id: mine, until: Date.now() + 12000}));
    return true;
  }
  function identity(el) {
    const labels = [...(el.labels || [])].map(text).join(' ');
    const labelled = (el.getAttribute('aria-labelledby') || '').split(/\s+/).map(id => text(document.getElementById(id))).join(' ');
    let nearby = '';
    if (!labels && !labelled) {
      let root = el.parentElement;
      while (root && root !== document.body) {
        const inputs = [...root.querySelectorAll('input,textarea,select,[role="combobox"]')].filter(visible);
        if (inputs.length > 1) break;
        const fieldLabels = root.querySelectorAll('label,[data-automation-id="formLabel"]');
        if (inputs.length === 1 && fieldLabels.length === 1) { nearby = text(fieldLabels[0]); break; }
        root = root.parentElement;
      }
    }
    return (labels || labelled || nearby || el.getAttribute('aria-label') || el.placeholder || el.name || el.id || '').trim().replace(/\*\s*$/, '');
  }
  function heading(el) {
    const labelled = (el.getAttribute('aria-labelledby') || '').split(/\s+/).map(id => text(document.getElementById(id))).join(' ');
    return core.norm(el.getAttribute('data-section') || labelled || text(el.querySelector(':scope > legend,:scope > h2,:scope > h3,:scope > h4,:scope > [role="heading"]')) || el.id);
  }
  function context(el) {
    let root = el.parentElement;
    while (root && root !== document.body) {
      const title = heading(root);
      const section = /education|academic|qualification/.test(title) ? 'education' : /employment|work experience|work history|professional experience/.test(title) ? 'employment' : '';
      if (section && root.querySelectorAll('input,textarea,select,[role="combobox"]').length >= 2) return {section, root};
      root = root.parentElement;
    }
    return {section: '', root: document.body};
  }
  function numberedHistoryIndex(el, section) {
    if (!section) return null;
    const names = section === 'employment' ? /\b(?:work experience|work history|employment)\s+(\d+)\b/ : /\b(?:education|qualification)\s+(\d+)\b/;
    let root = el.parentElement;
    while (root && root !== document.body) {
      const match = heading(root).match(names);
      if (match) return Number(match[1]) - 1;
      root = root.parentElement;
    }
    return null;
  }
  function accountScreen() {
    if (controls().some(el => el.type === 'password')) return true;
    const headings = core.norm([...document.querySelectorAll('h1,h2,[role="heading"]')].filter(visible).map(text).join(' '));
    return /\b(sign in|log in|create account|create your account|reset password|verify your|verification code|captcha)\b/.test(headings);
  }
  function nativeSet(el, value) {
    const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    if (setter) setter.call(el, value); else el.value = value;
    el.dispatchEvent(new Event('input', {bubbles: true}));
    el.dispatchEvent(new Event('change', {bubbles: true}));
    el.dispatchEvent(new Event('blur', {bubbles: true}));
  }
  function empty(el) {
    if (el.type === 'checkbox' || el.type === 'radio') return !el.checked;
    if (el instanceof HTMLSelectElement) return !el.value || /^(select( one| an option)?|please select|choose|none|no selection)$/.test(core.norm(text(el.selectedOptions[0])));
    if (el instanceof HTMLButtonElement) return !core.norm(text(el)) || /^(select( one| an option)?|please select|choose|none|no selection)$/.test(core.norm(text(el)));
    return !String(el.value || '').trim() || /^(select( one| an option)?|please select|choose)$/.test(core.norm(el.value));
  }
  function dateValue(el, value) {
    if (!/^\d{4}(-\d{2})?(-\d{2})?$/.test(value)) return value;
    if (el.type === 'month') return value.length >= 7 ? value.slice(0,7) : null;
    if (el.type === 'date') return value.length === 10 ? value : null;
    const format = core.norm(el.placeholder || el.getAttribute('aria-label'));
    if (/^(yyyy|year)$/.test(format)) return value.slice(0,4);
    if (/dd.*mm.*yyyy/.test(format)) return value.length === 10 ? value.slice(8,10)+'/'+value.slice(5,7)+'/'+value.slice(0,4) : null;
    if (/mm.*dd.*yyyy/.test(format)) return value.length === 10 ? value.slice(5,7)+'/'+value.slice(8,10)+'/'+value.slice(0,4) : null;
    if (/mm.*yyyy/.test(format)) return value.length >= 7 ? value.slice(5,7)+'/'+value.slice(0,4) : null;
    return value;
  }
  function skillScope(el) {
    return el.closest('[data-automation-id="formField-skills"],[role="group"],section,.form-group,.field') || el.parentElement;
  }
  function selectedSkills(el) {
    const scope = skillScope(el);
    const selectedLists = [...scope.querySelectorAll('[role="listbox"]')]
      .filter(list => /selected/.test(core.norm(list.getAttribute('aria-label'))));
    const tokens = selectedLists.length
      ? selectedLists.flatMap(list => [...list.querySelectorAll('[role="option"]')])
      : [...scope.querySelectorAll('[role="listitem"],[data-automation-id="selectedItem"],.select2-selection__choice,.sapMTokenText')];
    return tokens.map(tag => text(tag).replace(/^[×x]\s*/, '').replace(/,?\s*press delete to clear value\.?$/i, '').trim()).filter(Boolean);
  }
  const sameSkill = (candidate, desired) => {
    const rawLeft = String(candidate).trim().toLowerCase(), rawRight = String(desired).trim().toLowerCase();
    const left = core.norm(candidate), right = core.norm(desired);
    if (left === right || rawLeft.includes('(' + rawRight + ')')) return true;
    if (!left.startsWith(right + ' ')) return false;
    return /^(programming language|python library|software|tool|technology|database|framework|skill)$/.test(left.slice(right.length + 1));
  };
  async function dropdown(el, value, skillMode = false, choiceKey = '', force = false) {
    // An unmatched Workday choice must not be reopened on every background scan.
    if (!skillMode && !force && failedDropdowns.has(choiceKey)) return false;
    const original = el.value || '';
    const scope = skillMode ? skillScope(el) : el.closest('.select2-container,.sapMInputBase,.form-group,.field,td,[data-automation-id="formField"]') || el.parentElement;
    const alreadySelected = skillMode ? selectedSkills(el).some(tag => sameSkill(tag, value))
      : [...scope.querySelectorAll('[role="listitem"],.select2-selection__choice,.sapMTokenText,[data-automation-id="selectedItem"]')]
        .some(tag => core.optionMatch(text(tag).replace(/^[×x]\s*/, ''), value));
    if ((!skillMode && el instanceof HTMLButtonElement && core.optionMatch(text(el), value)) || alreadySelected) return true;
    el.click();
    if (el.tagName === 'INPUT') nativeSet(el, String(value));
    let sawChoices = false;
    for (let attempt = 0; attempt < 12; attempt++) {
      const controlled = el.getAttribute('aria-controls') || el.getAttribute('aria-owns');
      const list = controlled ? document.getElementById(controlled.split(' ')[0]) : null;
      const options = [...(list || document).querySelectorAll('[role="option"],.ui-autocomplete li,.select2-results__option')]
        .filter(option => visible(option) && (!skillMode || !/selected/.test(core.norm(option.closest('[role="listbox"]')?.getAttribute('aria-label')))));
      if (options.length) sawChoices = true;
      const exact = options.find(option => core.optionMatch(text(option), value));
      const option = exact || (skillMode ? options.find(option => sameSkill(text(option), value)) : null);
      if (option && option.getAttribute('aria-disabled') !== 'true') {
        const selectedValue = text(option).trim(); option.click(); await pause(70);
        // Do not report a typed search query as a saved selection.
        const committed = option.getAttribute('aria-selected') === 'true' || !visible(option)
          || el.getAttribute('aria-expanded') === 'false'
          || (skillMode ? selectedSkills(el).some(tag => core.optionMatch(tag, selectedValue))
            : [...scope.querySelectorAll('[role="listitem"],.select2-selection__choice,.sapMTokenText,[data-automation-id="selectedItem"]')].some(tag => core.optionMatch(text(tag).replace(/^[×x]\s*/, ''), value)));
        if (committed) {
          failedDropdowns.delete(choiceKey);
          return true;
        }
      }
      await pause(90);
    }
    if (skillMode && !sawChoices && el.tagName === 'INPUT') {
      // Free-text skill pickers commit one query at a time with Enter.
      el.dispatchEvent(new KeyboardEvent('keydown', {key: 'Enter', code: 'Enter', bubbles: true, cancelable: true}));
      el.dispatchEvent(new KeyboardEvent('keyup', {key: 'Enter', code: 'Enter', bubbles: true}));
      await pause(120);
      if (selectedSkills(el).some(tag => sameSkill(tag, value))) return true;
    }
    if (el.tagName === 'INPUT') nativeSet(el, original);
    el.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape', bubbles: true}));
    if (el.getAttribute('aria-expanded') === 'true' && el.tagName !== 'INPUT') el.click();
    el.blur();
    if (!skillMode) failedDropdowns.add(choiceKey);
    return false;
  }
  async function fill(el, value, label, force = false, choiceKey = '') {
    if (value === null || value === undefined || value === '' || (!force && userEdited.has(el))) return false;
    if (['password','hidden','file','submit','image'].includes(el.type)) return false;
    if (el.type === 'radio') {
      const group = controls().filter(other => other.type === 'radio' && other.name === el.name);
      const radio = group.find(other => core.optionMatch(identity(other) || other.value, value));
      if (!radio || radio.checked) return false;
      if (!force && group.some(other => other.checked)) return false;
      radio.click(); return radio.checked;
    }
    if (el.type === 'checkbox') {
      if (typeof value !== 'boolean' || el.checked === value || !/current|work here|still employ/.test(core.norm(label))) return false;
      el.click(); return el.checked === value;
    }
    const skillMode = core.skillsLabel(label);
    const staleSkillList = skillMode && String(value).includes(',') && String(el.value || '').trim() === String(value).trim();
    if (!force && !empty(el) && !staleSkillList) return false;
    if (staleSkillList) nativeSet(el, '');
    if (el instanceof HTMLSelectElement) {
      const option = [...el.options].find(option => !option.disabled && core.optionMatch(text(option), value));
      if (!option) return false;
      nativeSet(el, option.value); return el.value === option.value;
    }
    if (el.getAttribute('role') === 'combobox' || el.getAttribute('aria-autocomplete') || el.getAttribute('aria-haspopup') === 'listbox' || el.classList.contains('ui-autocomplete-input')
      || (skillMode && /\.myworkdayjobs\.com$/i.test(location.hostname))) {
      const multiMode = skillMode || core.multiValueLabel(label);
      const values = multiMode ? String(value).split(',').map(x => x.trim()).filter(Boolean) : [value];
      let committed = 0;
      const attempted = attemptedSkills.get(el) || new Set(); attemptedSkills.set(el, attempted);
      let processed = 0;
      for (const item of values) {
        if (skillMode && (selectedSkills(el).some(selected => sameSkill(selected, item)) || attempted.has(core.norm(item)))) continue;
        if (skillMode) attempted.add(core.norm(item));
        if (await dropdown(el, item, skillMode, choiceKey, force)) committed++;
        if (skillMode && ++processed >= 12) break;
      }
      return committed > 0;
    }
    value = dateValue(el, String(value));
    if (!value) return false;
    nativeSet(el, value);
    return el.value === value;
  }
  function notice(message) {
    if (dismissed) return;
    let box = document.getElementById('job-assistant-sf-status');
    if (!box) {
      box = document.createElement('div'); box.id = 'job-assistant-sf-status';
      box.style.cssText = 'position:fixed;bottom:12px;right:12px;z-index:2147483647;max-width:320px;padding:10px;border:1px solid #b8d4ca;border-radius:10px;background:#f5fffa;color:#174b3b;font:12px/1.4 Segoe UI,Arial;box-shadow:0 3px 12px #0002';
      const summary = document.createElement('span'); summary.dataset.summary = '';
      const title = document.createElement('strong'); title.textContent = /myworkdayjobs\.com$/i.test(location.hostname) ? 'Workday autofill' : 'SuccessFactors autofill';
      const edit = document.createElement('button'); edit.textContent = 'Edit defaults'; edit.type = 'button'; edit.onclick = () => chrome.runtime.sendMessage({type:'OPEN_SF_PROFILE'});
      const retry = document.createElement('button'); retry.textContent = 'Fill again'; retry.type = 'button'; retry.onclick = async () => {
        retry.disabled = true; retry.textContent = 'Filling…';
        try {
          for (let attempt = 0; running && attempt < 25; attempt++) await pause(100);
          fetchedAt = 0;
          await scan({force: true});
        } finally { retry.disabled = false; retry.textContent = 'Fill again'; }
      };
      const close = document.createElement('button'); close.textContent = '×'; close.type = 'button'; close.setAttribute('aria-label','Dismiss autofill notice'); close.onclick = () => { dismissed = true; box.remove(); };
      for (const button of [edit,retry,close]) button.style.cssText = 'margin-left:5px;font:inherit;cursor:pointer';
      box.append(title, document.createElement('br'), summary, document.createElement('br'), edit, retry, close); document.body.appendChild(box);
    }
    const summary = box.querySelector('[data-summary]');
    if (summary.textContent !== message) summary.textContent = message;
  }
  async function expandHistory(fields) {
    if (document.querySelector('[role="dialog"]')) return;
    for (const button of [...document.querySelectorAll('button,a[role="button"],input[type="button"]')].filter(visible)) {
      if (additions.has(button)) continue;
      const label = core.norm(text(button) || button.value || button.getAttribute('aria-label'));
      const named = /^add(?: another| new)? (education|qualification|employment|work experience|work history)(?: entry)?$/.test(label);
      if (!named && label !== 'add another') continue;
      // Workday labels these buttons only "Add Another"; use the containing form section.
      const section = named ? (/education|qualification/.test(label) ? 'education' : 'employment') : context(button).section;
      if (!section) continue;
      const count = fields.filter(el => context(el).section === section && /school|institution|university|employer|company/.test(core.norm(identity(el)))).length;
      if (count < (profile.profile[section] || []).length) {
        additions.add(button); button.click(); await pause(200);
        // The next pass may add another inline entry; modal Save buttons remain manual.
        if (controls().length > fields.length) additions.delete(button);
        return;
      }
    }
  }
  async function scan({force = false} = {}) {
    if (running || document.hidden || !owner(force) || accountScreen()) return;
    running = true;
    const lease = setInterval(owner, 4000);
    try {
      if (!profile || Date.now() - fetchedAt > 8000) {
        const response = await chrome.runtime.sendMessage({type:'GET_SF_PROFILE'});
        if (!response?.ok) throw new Error(response?.error || 'Start the shared Chrome helper.');
        if (profileRevision && profileRevision !== response.revision) {
          attemptedSkills = new WeakMap();
          failedDropdowns = new Set();
        }
        profile = response; profileRevision = response.revision; fetchedAt = Date.now();
      }
      if (!profile.enabled) { notice('Application autofill is off.'); return; }
      const fields = controls(), roots = {education: [], employment: []};
      for (const el of fields) { const ctx = context(el); if (ctx.section && !roots[ctx.section].includes(ctx.root)) roots[ctx.section].push(ctx.root); }
      const occurrence = new Map();
      let filled = 0, unresolved = 0;
      for (const el of fields) {
        const label = identity(el), ctx = context(el);
        if (!label || core.protectedQuestion(label)) continue;
        let index = ctx.section ? roots[ctx.section].indexOf(ctx.root) : 0;
        const numberedIndex = numberedHistoryIndex(el, ctx.section);
        if (numberedIndex !== null) index = numberedIndex;
        if (ctx.section && roots[ctx.section].length === 1 && numberedIndex === null) {
          const key = ctx.section + ':' + core.norm(label);
          index = occurrence.get(key) || 0; occurrence.set(key, index + 1);
        }
        const value = core.answer(label, ctx.section, index, profile);
        const choiceKey = [location.href, ctx.section, index, core.norm(label), core.norm(value)].join('|');
        if (await fill(el, value, label, force, choiceKey)) filled++;
        else if (empty(el) && (el.required || el.getAttribute('aria-required') === 'true')) unresolved++;
      }
      await expandHistory(fields);
      const result = force
        ? (filled ? filled + ' saved values reapplied. ' : 'No saved values could be reapplied. ')
        : (filled ? filled + ' fields filled. ' : 'Autofill checked. ');
      notice(result + (unresolved ? unresolved + ' required fields need review. ' : '') + 'Review before saving or submitting.');
    } catch (error) { notice(error.message); }
    finally { clearInterval(lease); running = false; }
  }
  function schedule() { if (!scheduled) scheduled = setTimeout(() => { scheduled = null; scan(); }, 250); }
  document.addEventListener('input', event => { if (event.isTrusted) userEdited.add(event.target); }, true);
  document.addEventListener('change', event => { if (event.isTrusted) userEdited.add(event.target); }, true);
  new MutationObserver(records => { if (records.some(record => !record.target.closest?.('#job-assistant-sf-status'))) schedule(); })
    .observe(document.documentElement, {subtree:true, childList:true});
  setInterval(schedule, 4000);
  window.addEventListener('focus', schedule);
  globalThis.SuccessFactorsAutofill = {scan, identity, context};
  schedule();
})();
