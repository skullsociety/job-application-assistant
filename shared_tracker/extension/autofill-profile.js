"use strict";
const form = document.querySelector('#autofill-form'), status = document.querySelector('#status');
const saveButton = document.querySelector('#save-profile'), loadStatus = document.querySelector('#load-status');
const retryButton = document.querySelector('#retry-load');
const PROFILE_URL = 'http://127.0.0.1:8767/api/autofill-profile';
const scalarFields = {prefix:'Prefix',full_name:'Full legal name',first_name:'First / given name',last_name:'Last / family name or surname',email:'Email',phone:'Phone number',phone_device_type:'Phone device type',country:'Country of residence',street_name:'Street name / address line 1',additional_address:'Additional address / address line 2',city:'City',postal_code:'Postal code',linkedin_url:'LinkedIn website',website_url:'Website 1',website_url_2:'Website 2',gender:'Gender',date_of_birth:'Date of birth',country_of_birth:'Country / territory of birth',ethnicity:'Race / ethnicity',religion:'Religion',nationality:'Primary nationality',additional_nationalities:'Additional nationalities (comma separated)',citizenship:'Citizenship / Singapore right-to-work status',years_work_experience:'Full-time working experience in years (excluding internships and part-time work)',expected_salary:'Expected monthly base salary',current_monthly_base_salary:'Current monthly base salary',current_annual_bonus:'Current annual bonus',current_variable_compensation:'Current variable compensation / income',salary_currency:'Salary currency',notice_period:'Notice required before leaving current employer',earliest_available_start_date:'Earliest available start date',work_authorized:'Legally authorised to work in job country',requires_sponsorship:'Visa / work-authorisation sponsorship required',holds_required_credentials:'Hold job-required certifications or clearance',willing_to_travel:'Willing and able to travel',preferred_office_location:'Preferred office location',professional_memberships:'Professional, social or sports memberships',financial_interest:'Financial interest disclosure',outside_employment_or_business:'Outside employment / business activity disclosure',disciplinary_history:'Dismissal / disciplinary history',criminal_record:'Criminal / regulatory proceedings',related_to_employer:'Related to an employee / partner (details or N/A)',relatives_at_employer:'Relatives employed by the organisation (details or N/A)',referral_source:'How did you hear about this role?',future_recruitment_consent:'Consent to recruitment for other positions',communications_consent:'Consent to job-related event communications',declaration_acknowledgement:'Accept application declaration',summary:'Professional summary',skills:'Resume key skills (comma separated)',certifications:'Certifications'};
const resumeScalarKeys = new Set(['years_work_experience', 'summary', 'skills', 'certifications']);
const historyFields = {education:{institution:'Institution',qualification:'Qualification',field_of_study:'Field of study',start_date:'Start date',end_date:'Completion date',country:'Country',grade:'Grade / result'},employment:{employer:'Employer',job_title:'Job title',start_date:'Start date',end_date:'End date',current:'Currently working here',country:'Country',description:'Responsibilities and achievements',reason_for_leaving:'Reason for leaving',salary:'Salary in this job (optional)'}};
const yesNo = ['','Yes','No'];
const choiceFields = {prefix:['','Dr.','Miss','Mr.','Mrs.','Ms.','Prof.'],phone_device_type:['','Mobile','Landline'],work_authorized:yesNo,requires_sponsorship:yesNo,holds_required_credentials:yesNo,willing_to_travel:yesNo,future_recruitment_consent:yesNo,communications_consent:yesNo,financial_interest:[...yesNo,'N/A'],outside_employment_or_business:[...yesNo,'N/A'],disciplinary_history:[...yesNo,'N/A'],criminal_record:[...yesNo,'N/A'],declaration_acknowledgement:[...yesNo,'N/A']};
let loaded = null, dirty = false, loading = null, saving = false;
async function fetchLocalProfile(method = 'GET', value) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);
  try {
    const response = await fetch(PROFILE_URL, {
      method, cache: 'no-store', signal: controller.signal,
      headers: {'X-Job-Assistant-Extension': chrome.runtime.id, ...(method === 'POST' ? {'Content-Type': 'application/json'} : {})},
      ...(method === 'POST' ? {body: JSON.stringify(value)} : {}),
    });
    const data = await response.json();
    if (!response.ok || !data?.ok) throw new Error(data?.error || 'The local assistant could not load your profile.');
    return data;
  } finally { clearTimeout(timeout); }
}
async function profileRequest(method = 'GET', value) {
  if (method === 'POST') return fetchLocalProfile(method, value);
  try { return await fetchLocalProfile(); }
  catch (error) {
    // Only connection failures need the native helper. Never retry a save:
    // a timed-out POST might already have committed the user's answers.
    if (!(error instanceof TypeError || error.name === 'AbortError')) throw error;
    try {
      const viaWorker = await chrome.runtime.sendMessage({type:'GET_SF_PROFILE'});
      if (viaWorker?.ok) return viaWorker;
    } catch (_) { /* The direct retry below reports the final failure. */ }
    return fetchLocalProfile();
  }
}
function input(label, value, key) {
  const wrapper = document.createElement('label'); wrapper.textContent = label;
  const field = document.createElement(choiceFields[key] ? 'select' : /summary|skills|certifications|description|answer/.test(key) ? 'textarea' : 'input');
  if (choiceFields[key]) for (const optionValue of choiceFields[key]) {
    const option = document.createElement('option'); option.value = optionValue; option.textContent = optionValue || 'Not set'; field.appendChild(option);
  }
  if (key === 'current') { field.type = 'checkbox'; field.checked = value === true; wrapper.className = 'check'; }
  else { field.value = value ?? ''; if (field.tagName === 'INPUT') field.type = ['earliest_available_start_date','date_of_birth'].includes(key) ? 'date' : 'text'; }
  field.dataset.key = key; wrapper.appendChild(field);
  if (field.tagName === 'TEXTAREA') wrapper.className = 'wide';
  return wrapper;
}
function renderHistory(section, entries) {
  const host = document.getElementById(section); host.replaceChildren();
  entries.forEach((entry, index) => {
    const card = document.createElement('div'); card.className = 'entry';
    const title = document.createElement('h3'); title.textContent = (section === 'education' ? 'Education ' : 'Experience ') + (index + 1);
    const grid = document.createElement('div'); grid.className = 'grid';
    for (const [key,label] of Object.entries(historyFields[section])) grid.appendChild(input(label, entry[key], key));
    const remove = document.createElement('button'); remove.type = 'button'; remove.textContent = 'Remove entry'; remove.onclick = () => { card.remove(); dirty = true; };
    card.append(title, grid, remove); host.appendChild(card);
  });
}
function history(section) {
  return [...document.querySelectorAll('#' + section + ' .entry')].map(card => Object.fromEntries([...card.querySelectorAll('[data-key]')].map(field => [field.dataset.key,field.type === 'checkbox' ? field.checked : field.value.trim()])));
}
function sameHistory(section, left, right) {
  const normalize = entries => entries.map(entry => Object.keys(historyFields[section]).map(key => key === 'current' ? entry[key] === true : String(entry[key] ?? '').trim()));
  return JSON.stringify(normalize(left)) === JSON.stringify(normalize(right));
}
function addAnswer(value = {}) {
  const row = document.createElement('div'); row.className = 'entry grid';
  row.append(input('Exact question', value.question, 'question'), input('Your answer', value.answer, 'answer'));
  const remove = document.createElement('button'); remove.type = 'button'; remove.textContent = 'Remove answer'; remove.onclick = () => { row.remove(); dirty = true; };
  row.appendChild(remove); document.querySelector('#custom-answers').appendChild(row);
}
function render(data) {
  if (!data?.ok || !data.storage_revision || !data.profile) throw new Error('The local assistant returned an incomplete profile. Restart it and reload this extension.');
  loaded = data; dirty = false;
  document.querySelector('#enabled').checked = data.enabled;
  document.querySelector('#source').textContent = data.source ? 'Defaults extracted automatically from: ' + data.source.name : 'No source resume found.';
  document.querySelector('#warnings').textContent = data.warnings.join(' ');
  const manualHost = document.querySelector('#contact-fields'), resumeHost = document.querySelector('#resume-fields');
  manualHost.replaceChildren(); resumeHost.replaceChildren();
  for (const [key,label] of Object.entries(scalarFields)) {
    const wrapper = input(label, data.profile[key], key);
    const tools = document.createElement('div'); tools.className = 'field-tools';
    const fromResume = Boolean(data.defaults[key]);
    const hint = document.createElement('span'); hint.textContent = key in data.overrides ? 'Your saved value' : fromResume ? 'From newest resume' : 'Enter and save manually';
    const reset = document.createElement('button'); reset.type = 'button'; reset.textContent = fromResume ? 'Use resume default' : 'Clear saved value';
    reset.onclick = () => { wrapper.querySelector('[data-key]').value = fromResume ? loaded.defaults[key] || '' : ''; delete loaded.overrides[key]; hint.textContent = fromResume ? 'From newest resume' : 'Enter and save manually'; dirty = true; };
    tools.append(hint,reset); wrapper.appendChild(tools); (resumeScalarKeys.has(key) ? resumeHost : manualHost).appendChild(wrapper);
  }
  for (const section of Object.keys(historyFields)) renderHistory(section, data.profile[section] || []);
  document.querySelector('#custom-answers').replaceChildren(); data.custom_answers.forEach(addAnswer);
  form.hidden = false;
  saveButton.disabled = false;
  retryButton.hidden = true;
  loadStatus.textContent = 'Saved answers loaded from this computer.';
}
async function load(force = false) {
  if (saving) return;
  if (dirty && !force) return;
  if (dirty && force && !confirm('Discard unsaved edits and read the newest resume?')) return;
  if (loading) return loading;
  loading = (async () => {
    const data = await Promise.race([
      profileRequest(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('The local assistant did not respond within 45 seconds. Run Setup Job Assistant Suite.bat, then reload this extension.')), 45000)),
    ]);
    if (!data?.ok) throw new Error(data?.error || 'Start the shared Chrome helper.');
    if (dirty && !force) return;
    if (force || data.revision !== loaded?.revision) { render(data); status.textContent = 'Newest resume defaults loaded. Your saved corrections are retained.'; }
  })();
  try { await loading; }
  catch (error) {
    if (!loaded) {
      form.hidden = true;
      saveButton.disabled = true;
      retryButton.hidden = false;
      document.querySelector('#source').textContent = 'Saved answers could not be loaded.';
      loadStatus.textContent = error.message + ' Do not re-enter or save details until this page loads.';
    }
    throw error;
  } finally { loading = null; }
}
form.addEventListener('input', () => { dirty = true; });
form.addEventListener('submit', async event => {
  event.preventDefault();
  if (!loaded?.ok || !loaded.storage_revision || saving) {
    status.textContent = 'Wait for your saved answers to load before saving.';
    return;
  }
  const overrides = {...loaded.overrides};
  for (const field of document.querySelectorAll('#contact-fields [data-key], #resume-fields [data-key]')) {
    const key = field.dataset.key, value = field.value.trim();
    if (value !== (loaded.defaults[key] || '')) overrides[key] = value; else delete overrides[key];
  }
  for (const section of Object.keys(historyFields)) {
    const entries = history(section);
    if (!sameHistory(section, entries, loaded.defaults[section] || [])) overrides[section] = entries; else delete overrides[section];
  }
  const custom_answers = [...document.querySelectorAll('#custom-answers .entry')].map(row => ({question:row.querySelector('[data-key="question"]').value.trim(),answer:row.querySelector('[data-key="answer"]').value.trim()})).filter(item => item.question);
  saving = true; saveButton.disabled = true;
  try {
    const data = await profileRequest('POST', {enabled:document.querySelector('#enabled').checked,overrides,custom_answers,base_storage_revision:loaded.storage_revision});
    if (!data?.ok) throw new Error(data?.error || 'Save failed.');
    render(data); status.textContent = 'Saved. The unified extension uses these defaults.';
  } catch(error) { status.textContent = error.message; }
  finally { saving = false; saveButton.disabled = false; }
});
document.querySelectorAll('[data-add]').forEach(button => button.onclick = () => { const section = button.dataset.add; renderHistory(section, [...history(section), {}]); dirty = true; });
document.querySelectorAll('[data-reset]').forEach(button => button.onclick = () => { const section = button.dataset.reset; renderHistory(section, loaded.defaults[section] || []); delete loaded.overrides[section]; dirty = true; });
document.querySelector('#add-answer').onclick = () => { addAnswer(); dirty = true; };
document.querySelector('#reload').onclick = () => load(true).catch(error => { status.textContent = error.message; });
retryButton.onclick = () => load(true).catch(error => { status.textContent = error.message; });
setInterval(() => load().catch(error => { status.textContent = error.message; }), 10000);
status.textContent = 'Connecting to the local assistant…';
load().catch(error => { status.textContent = error.message; });
