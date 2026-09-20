"use strict";
// Isolated synthetic forms only. Never connects to a real application or Chrome profile.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const {chromium} = require(require.resolve('playwright', {paths:[process.env.JOB_ASSISTANT_NODE_MODULES || path.join(__dirname,'../linkedin/node_modules')]}));
const asset = file => path.join(__dirname,'extension',file);
const profile = {ok:true,enabled:true,revision:'one',storage_revision:'storage-one',defaults:{full_name:'Alex Example',education:[{qualification:'Degree',institution:'Example University',end_date:'2020-06'}],employment:[]},overrides:{},custom_answers:[],source:{name:'example.pdf'},warnings:[],profile:{full_name:'Alex Example',first_name:'Alex',email:'alex@example.org',phone:'12345678',country:'Singapore',citizenship:'Singapore Citizen',years_work_experience:'7.3',skills:'Python, SQL',education:[{institution:'Example University',qualification:'Degree',end_date:'2020-06'}],employment:[{employer:'Example Ltd',job_title:'Analyst',current:true},{employer:'Previous Ltd',job_title:'Engineer',current:false}]}};
async function browserPage(html, url = 'https://career.successfactors.com/application', testProfile = profile) {
  const browser = await chromium.launch({channel:'chrome', headless:true});
  const page = await browser.newPage();
  await page.route('**/*', route => route.fulfill({contentType:'text/html',body:html}));
  await page.goto(url);
  await page.evaluate(data => {window.testData=data;window.chrome={runtime:{id:'test',sendMessage:async message=>{if(message.type==='SAVE_SF_PROFILE'){window.saved=message.value;}return window.testData;}}};}, testProfile);
  if (url === 'https://local.invalid/profile') await page.evaluate(() => {
    window.fetch = async (_requestUrl, options = {}) => {
      window.lastProfileRequest = {url: String(_requestUrl), headers: options.headers};
      if (options.method === 'POST') window.saved = JSON.parse(options.body);
      return {ok: true, json: async () => window.testData};
    };
  });
  return {browser,page};
}
test('fills text, real options, repeated history; skips unknown dates and existing answers', async () => {
  const {browser,page} = await browserPage(`<form><h1>Application</h1><label>First name<input id="first"></label><label>Email<input id="email" value="keep@example.org"></label><label>Country<select id="country"><option value="">Select One</option><option>Singapore</option></select></label>
  <fieldset><legend>Education</legend><label>Institution<input id="school"></label><label>Completion date<input type="date" id="date"></label></fieldset>
  <section><h2>Employment</h2><label>Employer<input id="employer1"></label><label>Job title<input id="title1"></label></section>
  <section><h2>Employment</h2><label>Employer<input id="employer2"></label><label>Job title<input id="title2"></label></section>
  <label>Phone Number<input id="phone-number"></label><label>Phone Extension<input id="phone-extension"></label>
  <label>What is your right-to-work-in-Singapore status?<select id="right-to-work"><option value="">Select One</option><option>Singapore Citizen</option><option>Permanent Resident</option></select></label>
  <label>How many years of working experience do you have (excluding internships and part-time jobs)?<textarea id="experience-years"></textarea></label>
  <label>I agree to the declaration<input type="checkbox" id="consent"></label><button type="submit" id="submit">Submit</button>
  <div class="field"><label for="skills">Skills</label><input role="combobox" aria-controls="options" id="skills"><ul id="options" role="listbox"></ul><div id="tokens"></div></div></form>`);
  try {
    await page.evaluate(()=>{
      document.querySelector('form').onsubmit = event => {event.preventDefault();window.submitted=true;};
      skills.addEventListener('input',()=>{options.replaceChildren();if(!skills.value)return;const item=document.createElement('li');item.role='option';item.textContent=skills.value;item.onclick=()=>{const tag=document.createElement('span');tag.role='listitem';tag.textContent=item.textContent;tokens.append(tag);skills.value='';options.replaceChildren();};options.append(item);});
    });
    await page.addScriptTag({path:asset('successfactors-core.js')});
    await page.addScriptTag({path:asset('successfactors-autofill.js')});
    await page.waitForFunction(()=>document.querySelectorAll('#tokens [role=listitem]').length===2);
    assert.equal(await page.locator('#first').inputValue(),'Alex');
    assert.equal(await page.locator('#email').inputValue(),'keep@example.org');
    assert.equal(await page.locator('#country').inputValue(),'Singapore');
    assert.equal(await page.locator('#school').inputValue(),'Example University');
    assert.equal(await page.locator('#date').inputValue(),'');
    assert.equal(await page.locator('#employer1').inputValue(),'Example Ltd');
    assert.equal(await page.locator('#employer2').inputValue(),'Previous Ltd');
    assert.equal(await page.locator('#phone-number').inputValue(),'12345678');
    assert.equal(await page.locator('#phone-extension').inputValue(),'');
    assert.equal(await page.locator('#right-to-work').inputValue(),'Singapore Citizen');
    assert.equal(await page.locator('#experience-years').inputValue(),'7.3');
    assert.equal(await page.locator('#consent').isChecked(),false);
    assert.equal(await page.evaluate(()=>!!window.submitted),false);
    await page.locator('#first').fill('Manual');
    await page.evaluate(()=>SuccessFactorsAutofill.scan());
    assert.equal(await page.locator('#first').inputValue(),'Manual');
    // An explicit retry is allowed to correct a stale value and take the lease
    // from another installed job-assistant extension.
    await page.evaluate(()=>document.documentElement.setAttribute('data-job-assistant-application-owner',JSON.stringify({id:'another-extension',until:Date.now()+12000})));
    await page.getByRole('button',{name:'Fill again'}).click();
    await page.waitForFunction(()=>document.querySelector('#first').value==='Alex');
    await page.waitForFunction(()=>document.querySelector('[data-summary]')?.textContent.includes('saved values reapplied'));
    assert.match(await page.locator('[data-summary]').textContent(),/saved values reapplied/);
  } finally {await browser.close();}
});
test('Workday selects profile choices and commits available resume skills as chips', async () => {
  const workdayProfile = {...profile,revision:'workday',profile:{...profile.profile,prefix:'Mr.',phone_device_type:'Mobile',street_name:'1 Example Street',additional_address:'Unit 02',city:'Singapore',postal_code:'123456',linkedin_url:'https://linkedin.com/in/example',website_url:'https://one.example',website_url_2:'https://two.example',gender:'Example gender',date_of_birth:'1990-02-03',country_of_birth:'Example birth country',ethnicity:'Example ethnicity',religion:'Example religion',nationality:'Example nationality',skills:'Unavailable Skill, AWS, Python, SQL'}};
  const {browser,page} = await browserPage(`<form><h1>Application</h1>
    <div class="field"><label>Prefix</label><button type="button" id="prefix" aria-label="Prefix" aria-haspopup="listbox" aria-expanded="false">Select One</button><ul id="prefix-options" role="listbox"></ul></div>
    <label>Phone Device Type<select id="device"><option value="">Select One</option><option>Mobile</option><option>Landline</option></select></label>
    <label>Street Name<input id="street"></label><label>Additional Address<input id="address2"></label><label>City<input id="city"></label><label>Postal Code<input id="postal"></label>
    <label>LinkedIn Website<input id="linkedin"></label><label>Website 1<input id="website1"></label><label>Website 2<input id="website2"></label>
    <label>Gender<select id="gender"><option value="">Select One</option><option>Example gender</option></select></label>
    <label>Date of Birth<input id="dob" type="date"></label>
    <label>Country / Territory of Birth<select id="birth-country"><option value="">Select One</option><option>Example birth country</option></select></label>
    <label>Race/Ethnicity<select id="ethnicity"><option value="">Select One</option><option>Example ethnicity</option></select></label>
    <label>Religion<select id="religion"><option value="">Select One</option><option>Example religion</option></select></label>
    <label>Primary Nationality<select id="nationality"><option value="">Select One</option><option>Example nationality</option></select></label>
    <div data-automation-id="formField-skills"><label for="skills">Type to Add Skills</label><input id="skills" role="combobox" aria-controls="skill-options"><ul id="skill-options" role="listbox" aria-label="Search Results"></ul><ul id="selected" role="listbox" aria-label="Selected Items"></ul></div>
    <button type="submit">Submit</button></form>`, 'https://tenant.myworkdayjobs.com/application', workdayProfile);
  try {
    await page.evaluate(()=>{
      const prefixOptions=document.getElementById('prefix-options'),skillOptions=document.getElementById('skill-options');
      prefix.onclick=()=>{prefix.setAttribute('aria-expanded','true');prefixOptions.replaceChildren();for(const value of ['Dr.','Miss','Mr.','Mrs.','Ms.','Prof.']){const option=document.createElement('li');option.role='option';option.textContent=value;option.onclick=()=>{prefix.textContent=value;prefix.setAttribute('aria-expanded','false');prefixOptions.replaceChildren();};prefixOptions.append(option);}};
      skills.addEventListener('input',()=>{skillOptions.replaceChildren();const query=skills.value;if(!query)return;const option=document.createElement('li');option.role='option';option.textContent=query==='AWS'?'Amazon Web Services (AWS)':query==='Python'?'Python (Programming Language)':query==='SQL'?'SQL':'No Items';if(option.textContent!=='No Items')option.onclick=()=>{const chip=document.createElement('li');chip.role='option';chip.textContent=option.textContent;selected.append(chip);skills.value='';skillOptions.replaceChildren();};skillOptions.append(option);});
    });
    await page.addScriptTag({path:asset('successfactors-core.js')});
    await page.addScriptTag({path:asset('successfactors-autofill.js')});
    await page.waitForFunction(()=>document.querySelectorAll('#selected [role=option]').length===3, null, {timeout:8000});
    assert.equal(await page.locator('#prefix').textContent(),'Mr.');
    assert.equal(await page.locator('#device').inputValue(),'Mobile');
    assert.equal(await page.locator('#street').inputValue(),'1 Example Street');
    assert.equal(await page.locator('#address2').inputValue(),'Unit 02');
    assert.equal(await page.locator('#city').inputValue(),'Singapore');
    assert.equal(await page.locator('#postal').inputValue(),'123456');
    assert.equal(await page.locator('#linkedin').inputValue(),'https://linkedin.com/in/example');
    assert.equal(await page.locator('#website1').inputValue(),'https://one.example');
    assert.equal(await page.locator('#website2').inputValue(),'https://two.example');
    assert.equal(await page.locator('#gender').inputValue(),'Example gender');
    assert.equal(await page.locator('#dob').inputValue(),'1990-02-03');
    assert.equal(await page.locator('#birth-country').inputValue(),'Example birth country');
    assert.equal(await page.locator('#ethnicity').inputValue(),'Example ethnicity');
    assert.equal(await page.locator('#religion').inputValue(),'Example religion');
    assert.equal(await page.locator('#nationality').inputValue(),'Example nationality');
    assert.deepEqual(await page.locator('#selected [role=option]').allTextContents(),['Amazon Web Services (AWS)','Python (Programming Language)','SQL']);
  } finally {await browser.close();}
});
test('Workday plain skill picker commits each saved skill with Enter, not commas', async () => {
  const testProfile = {...profile,revision:'plain-skills',profile:{...profile.profile,skills:'Python, SQL, PostgreSQL'}};
  const {browser,page} = await browserPage(`<form><h1>Application</h1>
    <div data-automation-id="formField-skills"><label for="skills">Type to Add Skills</label>
      <input id="skills" value="Python, SQL, PostgreSQL"><div id="tokens"></div></div>
    <button type="submit">Save and Continue</button></form>`,
    'https://tenant.myworkdayjobs.com/application', testProfile);
  try {
    await page.evaluate(() => {
      window.enteredSkills = []; window.submitted = false;
      document.querySelector('form').onsubmit = event => { event.preventDefault(); window.submitted = true; };
      skills.addEventListener('keydown', event => {
        if (event.key !== 'Enter') return;
        event.preventDefault();
        const skill = skills.value;
        window.enteredSkills.push(skill);
        const tag = document.createElement('span'); tag.role = 'listitem'; tag.textContent = skill;
        tokens.append(tag); skills.value = '';
      });
    });
    await page.addScriptTag({path:asset('successfactors-core.js')});
    await page.addScriptTag({path:asset('successfactors-autofill.js')});
    await page.waitForFunction(() => document.querySelectorAll('#tokens [role="listitem"]').length === 3,
      null, {timeout:10000});
    assert.deepEqual(await page.evaluate(() => enteredSkills), ['Python','SQL','PostgreSQL']);
    assert.equal(await page.locator('#skills').inputValue(), '');
    assert.equal(await page.evaluate(() => submitted), false);
  } finally {await browser.close();}
});
test('Workday waits for skill suggestions without blurring the search field', async () => {
  const testProfile = {...profile,revision:'delayed-skills',profile:{...profile.profile,skills:'Python'}};
  const {browser,page} = await browserPage(`<form><h1>Application</h1>
    <div data-automation-id="formField-skills"><label for="skills">Type to Add Skills</label>
      <input id="skills" placeholder="Search"><ul id="options" role="listbox"><li role="option">No Items</li></ul>
      <div id="tokens"></div></div></form>`, 'https://tenant.myworkdayjobs.com/application', testProfile);
  try {
    await page.evaluate(() => {
      skills.addEventListener('blur', () => { options.innerHTML = '<li role="option">No Items</li>'; });
      skills.addEventListener('input', () => {
        options.innerHTML = '<li role="option">No Items</li>';
        if (skills.value !== 'Python') return;
        setTimeout(() => {
          if (document.activeElement !== skills || skills.value !== 'Python') return;
          options.replaceChildren();
          const option = document.createElement('li'); option.role = 'option'; option.textContent = 'Python';
          option.onclick = () => {
            const tag = document.createElement('span'); tag.role = 'listitem'; tag.textContent = 'Python';
            tokens.append(tag); skills.value = ''; options.replaceChildren();
          };
          options.append(option);
        }, 80);
      });
    });
    await page.addScriptTag({path:asset('successfactors-core.js')});
    await page.addScriptTag({path:asset('successfactors-autofill.js')});
    await page.waitForFunction(() => document.querySelectorAll('#tokens [role="listitem"]').length === 1);
    assert.equal(await page.locator('#skills').inputValue(), '');
  } finally {await browser.close();}
});
test('Workday selects matching skill checkboxes one query at a time', async () => {
  const testProfile = {...profile,revision:'checkbox-skills',profile:{...profile.profile,skills:'Python, SQL'}};
  const {browser,page} = await browserPage(`<form><h1>Application</h1>
    <div data-automation-id="formField-skills"><label for="skills">Type to Add Skills</label>
      <input id="skills" placeholder="Search"><ul id="options" role="listbox" aria-label="Search Results"></ul>
      <ul id="selected" role="listbox" aria-label="Selected Items"></ul></div></form>`,
    'https://tenant.myworkdayjobs.com/application', testProfile);
  try {
    await page.evaluate(() => {
      window.checkedSkills = [];
      skills.addEventListener('input', () => {
        options.replaceChildren();
        const name = skills.value === 'Python' ? 'Python (Programming Language)' : skills.value === 'SQL' ? 'SQL' : '';
        if (!name) return;
        const option = document.createElement('li'); option.role = 'option';
        const checkbox = document.createElement('input'); checkbox.type = 'checkbox';
        const label = document.createElement('span'); label.textContent = name;
        checkbox.onclick = () => {
          window.checkedSkills.push(name);
          const tag = document.createElement('li'); tag.role = 'option'; tag.textContent = name;
          selected.append(tag);
        };
        option.append(checkbox,label); options.append(option);
      });
    });
    await page.addScriptTag({path:asset('successfactors-core.js')});
    await page.addScriptTag({path:asset('successfactors-autofill.js')});
    await page.waitForFunction(() => document.querySelectorAll('#selected [role="option"]').length === 2
      && document.querySelector('#skills').value === '');
    assert.deepEqual(await page.evaluate(() => checkedSkills), ['Python (Programming Language)','SQL']);
    assert.deepEqual(await page.locator('#selected [role="option"]').allTextContents(),
      ['Python (Programming Language)','SQL']);
    assert.equal(await page.locator('#skills').inputValue(), '');
  } finally {await browser.close();}
});
test('Workday presses Enter when clicking a skill result only highlights it', async () => {
  const testProfile = {...profile,revision:'skill-search-enter',profile:{...profile.profile,skills:'SQL'}};
  const {browser,page} = await browserPage(`<form><h1>Application</h1>
    <div data-automation-id="formField-skills"><label for="skills">Type to Add Skills</label>
      <input id="skills" role="combobox" aria-controls="skill-results">
      <ul id="skill-results" role="listbox" aria-label="Search Results"></ul>
      <ul id="selected" role="listbox" aria-label="Selected Items"></ul></div></form>`,
    'https://tenant.myworkdayjobs.com/application', testProfile);
  try {
    await page.evaluate(() => {
      const results = document.querySelector('#skill-results');
      skills.addEventListener('input', () => {
        results.replaceChildren();
        if (skills.value !== 'SQL') return;
        const option = document.createElement('li'); option.role = 'option';
        const visualCheckbox = document.createElement('span'); visualCheckbox.className = 'visual-checkbox';
        const label = document.createElement('span'); label.textContent = 'Structured Query Language (SQL)';
        option.onclick = () => { skills.dataset.highlighted = 'Structured Query Language (SQL)'; };
        option.append(visualCheckbox,label); results.append(option);
      });
      skills.addEventListener('keydown', event => {
        if (event.key !== 'Enter' || !skills.dataset.highlighted) return;
        event.preventDefault();
        const tag = document.createElement('li'); tag.role = 'option'; tag.textContent = skills.dataset.highlighted;
        selected.append(tag); skills.value = ''; results.replaceChildren();
      });
    });
    await page.addScriptTag({path:asset('successfactors-core.js')});
    await page.addScriptTag({path:asset('successfactors-autofill.js')});
    await page.waitForFunction(() => document.querySelector('#selected [role="option"]')?.textContent === 'Structured Query Language (SQL)', null, {timeout:5000});
    assert.equal(await page.locator('#skills').inputValue(), '');
    assert.equal(await page.locator('#selected [role="option"]').textContent(), 'Structured Query Language (SQL)');
  } finally {await browser.close();}
});
test('Workday leaves an existing skill set unchanged until Fill again is clicked', async () => {
  const testProfile = {...profile,revision:'existing-skills',profile:{...profile.profile,skills:'Python, SQL'}};
  const {browser,page} = await browserPage(`<form><h1>Application</h1>
    <div data-automation-id="formField-skills"><label for="skills">Type to Add Skills</label>
      <input id="skills" placeholder="Search"><ul id="options" role="listbox" aria-label="Search Results"></ul>
      <ul id="selected" role="listbox" aria-label="Selected Items"><li role="option">Python</li></ul></div></form>`,
    'https://tenant.myworkdayjobs.com/application', testProfile);
  try {
    await page.evaluate(() => {
      window.skillQueries = [];
      skills.addEventListener('input', () => {
        if (skills.value) window.skillQueries.push(skills.value);
        options.replaceChildren();
        if (skills.value !== 'SQL') return;
        const option = document.createElement('li'); option.role = 'option'; option.textContent = 'SQL';
        option.onclick = () => {
          const tag = document.createElement('li'); tag.role = 'option'; tag.textContent = 'SQL';
          selected.append(tag); skills.value = ''; options.replaceChildren();
        };
        options.append(option);
      });
    });
    await page.addScriptTag({path:asset('successfactors-core.js')});
    await page.addScriptTag({path:asset('successfactors-autofill.js')});
    await page.waitForFunction(() => document.querySelector('[data-summary]')?.textContent.includes('Existing skills were left unchanged'));
    assert.deepEqual(await page.locator('#selected [role="option"]').allTextContents(), ['Python']);
    assert.deepEqual(await page.evaluate(() => skillQueries), []);
    await page.getByRole('button', {name:'Fill again'}).click();
    await page.waitForFunction(() => document.querySelectorAll('#selected [role="option"]').length === 2);
    assert.deepEqual(await page.locator('#selected [role="option"]').allTextContents(), ['Python','SQL']);
    assert.deepEqual(await page.evaluate(() => skillQueries), ['SQL']);
  } finally {await browser.close();}
});
test('Fill again retries a skill after Workday first shows No Items', async () => {
  const testProfile = {...profile,revision:'retry-skills',profile:{...profile.profile,skills:'Python'}};
  const {browser,page} = await browserPage(`<form><h1>Application</h1>
    <div data-automation-id="formField-skills"><label for="skills">Type to Add Skills</label>
      <input id="skills" placeholder="Search"><ul id="options" role="listbox"></ul>
      <div id="tokens"></div></div></form>`, 'https://tenant.myworkdayjobs.com/application', testProfile);
  try {
    await page.evaluate(() => {
      window.skillAvailable = false;
      skills.addEventListener('input', () => {
        options.replaceChildren();
        const option = document.createElement('li'); option.role = 'option';
        option.textContent = window.skillAvailable ? 'Python' : 'No Items';
        if (window.skillAvailable) option.onclick = () => {
          const tag = document.createElement('span'); tag.role = 'listitem'; tag.textContent = 'Python';
          tokens.append(tag); skills.value = ''; options.replaceChildren();
        };
        options.append(option);
      });
    });
    await page.addScriptTag({path:asset('successfactors-core.js')});
    await page.addScriptTag({path:asset('successfactors-autofill.js')});
    await page.waitForFunction(() => document.querySelector('[data-summary]')?.textContent.includes('1 skill was not selected'));
    assert.equal(await page.locator('#tokens [role="listitem"]').count(), 0);
    await page.evaluate(() => { window.skillAvailable = true; });
    await page.getByRole('button', {name:'Fill again'}).click();
    await page.waitForFunction(() => document.querySelectorAll('#tokens [role="listitem"]').length === 1);
    await page.waitForFunction(() => !document.querySelector('[data-summary]')?.textContent.includes('skill was not selected'));
  } finally {await browser.close();}
});
test('Workday leaves an unmatched degree choice alone for manual selection', async () => {
  const testProfile = {...profile,revision:'degree',profile:{...profile.profile,education:[{qualification:'Bachelor of Engineering'}]}};
  const {browser,page} = await browserPage(`<form><h1>Application</h1><section><h2>Education</h2>
    <label>Institution<input></label><label>From<input></label>
    <button type="button" id="degree" aria-label="Degree" aria-haspopup="listbox" aria-expanded="false">Select One</button>
    <ul id="degrees" role="listbox"></ul></section></form>`, 'https://tenant.myworkdayjobs.com/application', testProfile);
  try {
    await page.evaluate(() => {
      window.degreeOpens = 0;
      degree.onclick = () => {
        const open = degree.getAttribute('aria-expanded') !== 'true';
        degree.setAttribute('aria-expanded', String(open));
        degrees.replaceChildren();
        if (!open) return;
        window.degreeOpens++;
        for (const value of ['Primary/Elementary', 'Secondary/High School']) {
          const option = document.createElement('li'); option.role = 'option'; option.textContent = value;
          option.onclick = () => { degree.textContent = value; degree.setAttribute('aria-expanded', 'false'); degrees.replaceChildren(); };
          degrees.append(option);
        }
      };
    });
    await page.addScriptTag({path:asset('successfactors-core.js')});
    await page.addScriptTag({path:asset('successfactors-autofill.js')});
    await page.waitForFunction(() => document.querySelector('[data-summary]')?.textContent.includes('Review before saving'));
    assert.equal(await page.evaluate(() => degreeOpens), 1);
    assert.equal(await page.locator('#degree').getAttribute('aria-expanded'), 'false');
    await page.evaluate(() => SuccessFactorsAutofill.scan());
    assert.equal(await page.evaluate(() => degreeOpens), 1);
    await page.locator('#degree').click();
    await page.getByRole('option', {name:'Secondary/High School'}).click();
    await page.evaluate(() => SuccessFactorsAutofill.scan());
    assert.equal(await page.locator('#degree').textContent(), 'Secondary/High School');
    assert.equal(await page.locator('#degree').getAttribute('aria-expanded'), 'false');
  } finally {await browser.close();}
});
test('Workday fills separate month and year controls under shared history date labels', async () => {
  const testProfile = {...profile,profile:{...profile.profile,
    education:[{start_date:'2018-04',end_date:'2020-04'}],
    employment:[{start_date:'2021-10',end_date:'2022-04'}]}};
  const dateFields = name => `<div data-automation-id="formField-${name}Date"><span data-automation-id="formLabel">${name === 'start' ? 'From' : 'To (Actual or Expected)'}*</span>
    <input data-automation-id="dateSectionMonth-input" aria-label="Month" placeholder="MM" maxlength="2">
    <input data-automation-id="dateSectionYear-input" aria-label="Year" placeholder="YYYY" maxlength="4"></div>`;
  const {browser,page} = await browserPage(`<form>
    <section id="education"><h2>Education 1</h2>${dateFields('start')}${dateFields('end')}</section>
    <section id="employment"><h2>Work Experience 1</h2>${dateFields('start')}${dateFields('end')}</section></form>`,
    'https://tenant.myworkdayjobs.com/application', testProfile);
  try {
    await page.addScriptTag({path:asset('successfactors-core.js')});
    await page.addScriptTag({path:asset('successfactors-autofill.js')});
    await page.waitForFunction(() => [...document.querySelectorAll('#employment input')].every(input => input.value), null, {timeout:5000});
    assert.deepEqual(await page.locator('#education input').evaluateAll(inputs => inputs.map(input => input.value)), ['04','2018','04','2020']);
    assert.deepEqual(await page.locator('#employment input').evaluateAll(inputs => inputs.map(input => input.value)), ['10','2021','04','2022']);
  } finally {await browser.close();}
});
test('Workday commits role descriptions through focusout validation', async () => {
  const testProfile = {...profile,profile:{...profile.profile,employment:[{job_title:'Analyst',description:'Built validated reports.'}]}};
  const {browser,page} = await browserPage(`<form><section><h2>Work Experience 1</h2>
    <label>Job Title<input></label><label>Role Description<textarea id="description" aria-invalid="true"></textarea></label>
    <div id="error">Role Description is required</div></section></form>`, 'https://tenant.myworkdayjobs.com/application', testProfile);
  try {
    await page.evaluate(()=>{
      description.addEventListener('focusout',()=>{
        window.acceptedDescription=description.value;
        description.setAttribute('aria-invalid', String(!description.value));
        document.getElementById('error').textContent=description.value ? '' : 'Role Description is required';
      });
    });
    await page.addScriptTag({path:asset('successfactors-core.js')});
    await page.addScriptTag({path:asset('successfactors-autofill.js')});
    await page.waitForFunction(()=>window.acceptedDescription==='Built validated reports.',null,{timeout:5000});
    assert.equal(await page.locator('#error').textContent(),'');
    assert.equal(await page.locator('#description').getAttribute('aria-invalid'),'false');
  } finally {await browser.close();}
});
test('DBS education searches with Enter, checks radio results, maps degrees and nested years', async () => {
  const testProfile = {...profile,profile:{...profile.profile,education:[{institution:'General Assembly',qualification:'Diploma in Biotechnology',start_date:'2010-04',end_date:'2014-04'}]}};
  const {browser,page} = await browserPage(`<form><section><h2>Education 1</h2>
    <div data-automation-id="formField-school"><label for="school">School or University*</label>
    <input id="school" enterkeyhint="search" data-uxi-widget-type="selectinput" data-uxi-multiselect-id="school-widget" value="General Assembly"><ul aria-label="items selected" role="listbox" id="selected"></ul></div>
    <label>Degree<button id="degree" type="button" aria-haspopup="listbox">Select One</button></label><ul id="degrees" role="listbox"></ul>
    <div role="group" aria-label="From"><div role="group" data-automation-id="dateInputWrapper"><input id="education-9--firstYearAttended-dateSectionYear-input" data-automation-id="dateSectionYear-input" role="spinbutton" aria-label="Year"></div></div>
    <div role="group" aria-label="To"><div role="group" data-automation-id="dateInputWrapper"><input id="education-9--lastYearAttended-dateSectionYear-input" data-automation-id="dateSectionYear-input" role="spinbutton" aria-label="Year"></div></div>
    </section><div data-associated-widget="school-widget" id="popup"></div></form>`, 'https://tenant.myworkdayjobs.com/application', testProfile);
  try {
    await page.evaluate(() => {
      let searchQuery = '';
      school.addEventListener('input',()=>{const value=school.value;setTimeout(()=>{searchQuery=value;},40);});
      school.addEventListener('keydown', event => {
        if (event.key !== 'Enter') return;
        event.preventDefault(); popup.replaceChildren();
        if (searchQuery === 'General Assembly') {popup.textContent='No matches found'; return;}
        if (searchQuery !== 'Others') return;
        const option=document.createElement('div'); option.role='option'; option.setAttribute('aria-selected','true');
        const radio=document.createElement('input'); radio.type='radio';
        option.append(radio,document.createTextNode('Others'));
        radio.onclick=()=>{const tag=document.createElement('li');tag.role='option';tag.textContent='Others';selected.append(tag);school.value='';popup.replaceChildren();};
        popup.append(option);
      });
      degree.onclick=()=>{degrees.replaceChildren();for(const name of ['Bachelor Degree Honours','Diploma / Professional Diploma']){const option=document.createElement('li');option.role='option';option.textContent=name;option.onclick=()=>{degree.textContent=name;degree.setAttribute('aria-expanded','false');degrees.replaceChildren();};degrees.append(option);}};
    });
    await page.addScriptTag({path:asset('successfactors-core.js')});
    await page.addScriptTag({path:asset('successfactors-autofill.js')});
    await page.waitForFunction(()=>document.getElementById('education-9--lastYearAttended-dateSectionYear-input').value==='2014',null,{timeout:10000});
    assert.equal(await page.locator('#selected').textContent(),'Others');
    assert.equal(await page.locator('#degree').textContent(),'Diploma / Professional Diploma');
    assert.equal(await page.locator('[id="education-9--firstYearAttended-dateSectionYear-input"]').inputValue(),'2010');
  } finally {await browser.close();}
});
test('Workday year-only education inputs take the year from resume dates', async () => {
  const testProfile = {...profile,revision:'education-years',profile:{...profile.profile,
    education:[{institution:'Example University',start_date:'2018-08',end_date:'2022-06'}]}};
  const {browser,page} = await browserPage(`<form><h1>Application</h1><section><h2>Education</h2>
    <label>From<input id="from-year" placeholder="YYYY" maxlength="4"></label>
    <label>To (Actual or Expected)<input id="to-year" placeholder="YYYY" maxlength="4"></label>
  </section></form>`, 'https://tenant.myworkdayjobs.com/application', testProfile);
  try {
    await page.addScriptTag({path:asset('successfactors-core.js')});
    await page.addScriptTag({path:asset('successfactors-autofill.js')});
    await page.waitForFunction(() => document.querySelector('#to-year').value === '2022');
    assert.equal(await page.locator('#from-year').inputValue(), '2018');
    assert.equal(await page.locator('#to-year').inputValue(), '2022');
  } finally {await browser.close();}
});
test('Workday commits school and field of study as education tags with Enter', async () => {
  const testProfile = {...profile,revision:'education-tags',profile:{...profile.profile,
    education:[{institution:'Temasek Polytechnic',field_of_study:'Applied Biology with Biotechnology'}]}};
  const {browser,page} = await browserPage(`<form><h1>My Experience</h1><section><h2>Education</h2>
    <div data-automation-id="formField-school"><label for="school">School or University</label>
      <input id="school" role="combobox"><div class="tokens"></div></div>
    <div data-automation-id="formField-fieldOfStudy"><label for="study">Field of Study</label>
      <input id="study" role="combobox"><div class="tokens"></div></div>
  </section></form>`, 'https://tenant.myworkdayjobs.com/application', testProfile);
  try {
    await page.evaluate(() => {
      for (const input of [school,study]) input.addEventListener('keydown', event => {
        if (event.key !== 'Enter') return;
        event.preventDefault();
        const tag = document.createElement('span'); tag.role = 'listitem'; tag.textContent = input.value;
        input.parentElement.querySelector('.tokens').append(tag); input.value = '';
      });
    });
    await page.addScriptTag({path:asset('successfactors-core.js')});
    await page.addScriptTag({path:asset('successfactors-autofill.js')});
    await page.waitForFunction(() => document.querySelectorAll('[role="listitem"]').length === 2);
    assert.equal(await page.locator('[data-automation-id="formField-school"] [role="listitem"]').textContent(), 'Temasek Polytechnic');
    assert.equal(await page.locator('[data-automation-id="formField-fieldOfStudy"] [role="listitem"]').textContent(), 'Applied Biology with Biotechnology');
    assert.equal(await page.locator('#school').inputValue(), '');
    assert.equal(await page.locator('#study').inputValue(), '');
  } finally {await browser.close();}
});
test('Workday presses Enter when clicking a school result only highlights it', async () => {
  const testProfile = {...profile,revision:'school-search-enter',profile:{...profile.profile,
    education:[{institution:'Northumbria University'}]}};
  const {browser,page} = await browserPage(`<form><h1>My Experience</h1><section><h2>Education</h2>
    <div data-automation-id="formField-school"><label for="school">School or University</label>
      <input id="school" role="combobox" aria-controls="school-results"><div class="tokens"></div>
      <ul id="school-results" role="listbox" aria-label="Search Results"></ul></div>
    <label>Degree<input id="degree"></label>
  </section></form>`, 'https://tenant.myworkdayjobs.com/application', testProfile);
  try {
    await page.evaluate(() => {
      const schoolResults = document.querySelector('#school-results');
      school.addEventListener('input', () => {
        schoolResults.replaceChildren();
        if (!school.value) return;
        for (const name of ['Northumbria University', 'University of Northumbria at Newcastle']) {
          const option = document.createElement('li'); option.role = 'option'; option.textContent = name;
          option.onclick = () => { school.dataset.highlighted = name; };
          schoolResults.append(option);
        }
      });
      school.addEventListener('keydown', event => {
        if (event.key !== 'Enter' || !school.dataset.highlighted) return;
        event.preventDefault();
        const tag = document.createElement('span'); tag.role = 'listitem'; tag.textContent = school.dataset.highlighted;
        school.parentElement.querySelector('.tokens').append(tag);
        school.value = ''; schoolResults.replaceChildren();
      });
    });
    await page.addScriptTag({path:asset('successfactors-core.js')});
    await page.addScriptTag({path:asset('successfactors-autofill.js')});
    await page.waitForFunction(() => document.querySelector('[role="listitem"]')?.textContent === 'Northumbria University', null, {timeout:5000});
    assert.equal(await page.locator('#school').inputValue(), '');
    assert.equal(await page.locator('[role="listitem"]').textContent(), 'Northumbria University');
  } finally {await browser.close();}
});
test('Workday selects Others when a school has no catalogue match', async () => {
  const testProfile = {...profile,revision:'school-others',profile:{...profile.profile,
    education:[{institution:'General Assembly'}]}};
  const {browser,page} = await browserPage(`<form><h1>My Experience</h1><section><h2>Education</h2>
    <div data-automation-id="formField-school"><label for="school">School or University</label>
      <input id="school" role="combobox" aria-controls="school-results"><div class="tokens"></div>
      <div id="no-match"></div><ul id="school-results" role="listbox" aria-label="Search Results"></ul></div>
    <label>Degree<input></label>
  </section></form>`, 'https://tenant.myworkdayjobs.com/application', testProfile);
  try {
    await page.evaluate(() => {
      const results = document.querySelector('#school-results'), noMatch = document.querySelector('#no-match');
      school.addEventListener('input', () => {
        results.replaceChildren(); noMatch.textContent = '';
        if (!school.value) return;
        if (school.value === 'General Assembly') {
          noMatch.textContent = 'No matches found';
          const empty = document.createElement('li'); empty.role = 'option'; empty.textContent = 'No Items.'; results.append(empty);
          return;
        }
        if (school.value === 'Others') {
          const option = document.createElement('li'); option.role = 'option'; option.textContent = 'Others';
          option.onclick = () => { school.dataset.highlighted = 'Others'; }; results.append(option);
        }
      });
      school.addEventListener('keydown', event => {
        if (event.key !== 'Enter' || !school.dataset.highlighted) return;
        event.preventDefault();
        const tag = document.createElement('span'); tag.role = 'listitem'; tag.textContent = school.dataset.highlighted;
        school.parentElement.querySelector('.tokens').append(tag);
        school.value = ''; results.replaceChildren(); noMatch.textContent = '';
      });
    });
    await page.addScriptTag({path:asset('successfactors-core.js')});
    await page.addScriptTag({path:asset('successfactors-autofill.js')});
    await page.waitForFunction(() => document.querySelector('[role="listitem"]')?.textContent === 'Others', null, {timeout:8000});
    assert.equal(await page.locator('#school').inputValue(), '');
    assert.equal(await page.locator('[role="listitem"]').textContent(), 'Others');
  } finally {await browser.close();}
});
test('Workday Add Another creates and fills remaining work and education entries', async () => {
  const testProfile = {...profile,revision:'history',profile:{...profile.profile,
    employment:[{employer:'Current Co',job_title:'Analyst'},{employer:'Earlier Co',job_title:'Engineer'}],
    education:[{institution:'Recent University'},{institution:'Earlier College'}]}};
  const {browser,page} = await browserPage(`<form><h1>My Experience</h1>
    <section id="work"><h2>Work Experience</h2><div class="entry"><h3>Work Experience 1</h3>
      <label>Job Title<input></label><label>Company<input></label></div>
      <button type="button" id="add-work">Add Another</button></section>
    <section id="education"><h2>Education</h2><div class="entry"><h3>Education 1</h3>
      <label>Institution<input></label><label>Degree<input></label></div>
      <button type="button" id="add-education">Add Another</button></section>
    <section><h2>Other Information</h2><label>Other<input></label><label>Detail<input></label>
      <button type="button" id="add-unrelated">Add Another</button></section></form>`,
    'https://tenant.myworkdayjobs.com/application', testProfile);
  try {
    await page.evaluate(() => {
      window.unrelatedClicks = 0;
      document.querySelector('#add-unrelated').onclick = () => { window.unrelatedClicks++; };
      for (const [section, heading, labels] of [
        ['work','Work Experience',['Job Title','Company']],
        ['education','Education',['Institution','Degree']]
      ]) document.querySelector('#add-' + section).onclick = () => {
        const root = document.querySelector('#' + section);
        const entry = document.createElement('div'); entry.className = 'entry';
        const title = document.createElement('h3'); title.textContent = heading + ' 2'; entry.append(title);
        for (const name of labels) {
          const label = document.createElement('label'); label.textContent = name;
          label.append(document.createElement('input')); entry.append(label);
        }
        root.insertBefore(entry, document.querySelector('#add-' + section));
      };
    });
    await page.addScriptTag({path:asset('successfactors-core.js')});
    await page.addScriptTag({path:asset('successfactors-autofill.js')});
    await page.waitForFunction(() => document.querySelectorAll('#work .entry').length === 2
      && document.querySelectorAll('#education .entry').length === 2
      && document.querySelectorAll('#work .entry')[1].querySelector('input').value === 'Engineer'
      && document.querySelectorAll('#education .entry')[1].querySelector('input').value === 'Earlier College');
    assert.deepEqual(await page.locator('#work .entry input').evaluateAll(inputs => inputs.map(input => input.value)),
      ['Analyst','Current Co','Engineer','Earlier Co']);
    assert.deepEqual(await page.locator('#education .entry input').evaluateAll(inputs => inputs.map(input => input.value)),
      ['Recent University','','Earlier College','']);
    assert.equal(await page.evaluate(() => unrelatedClicks), 0);
  } finally {await browser.close();}
});
test('Workday automatic pass respects deleted entries and cleared fields', async () => {
  const testProfile = {...profile,revision:'one-pass',profile:{...profile.profile,
    employment:[{employer:'Keep Co',job_title:'Keep role'},{employer:'Optional Co',job_title:'Optional role'}],education:[]}};
  const {browser,page} = await browserPage(`<form><h1>My Experience</h1>
    <section id="work"><h2>Work Experience</h2><div class="entry" id="work-1"><h3>Work Experience 1</h3>
      <label>Job Title<input id="first-title"></label><label>Company<input></label></div>
      <button type="button" id="add-work">Add Another</button></section></form>`,
    'https://tenant.myworkdayjobs.com/application', testProfile);
  try {
    await page.evaluate(() => {
      window.addClicks = 0;
      document.querySelector('#add-work').onclick = () => {
        if (document.querySelector('#work-2')) return;
        window.addClicks++;
        const entry = document.createElement('div'); entry.className = 'entry'; entry.id = 'work-2';
        entry.innerHTML = '<h3>Work Experience 2</h3><label>Job Title<input></label><label>Company<input></label><button type="button" class="delete">Delete</button>';
        entry.querySelector('.delete').onclick = () => entry.remove();
        document.querySelector('#work').insertBefore(entry, document.querySelector('#add-work'));
      };
    });
    await page.addScriptTag({path:asset('successfactors-core.js')});
    await page.addScriptTag({path:asset('successfactors-autofill.js')});
    await page.waitForFunction(() => document.querySelector('#work-2 input')?.value === 'Optional role'
      && document.querySelector('[data-summary]')?.textContent.includes('Automatic filling is now paused'));
    await page.locator('#work-2 .delete').click();
    await page.locator('#first-title').fill('');
    await page.evaluate(() => SuccessFactorsAutofill.scan());
    await page.waitForTimeout(700);
    assert.equal(await page.locator('#work-2').count(), 0);
    assert.equal(await page.locator('#first-title').inputValue(), '');
    assert.equal(await page.evaluate(() => addClicks), 1);
    await page.getByRole('button', {name:'Fill again'}).click();
    await page.waitForFunction(() => document.querySelector('#work-2 input')?.value === 'Optional role'
      && document.querySelector('#first-title').value === 'Keep role');
    assert.equal(await page.evaluate(() => addClicks), 2);
  } finally {await browser.close();}
});
test('Workday numbered history entries keep resume order and fill month/year dates', async () => {
  const testProfile = {...profile,revision:'numbered-history',profile:{...profile.profile,
    employment:[
      {job_title:'Newest role',employer:'Newest Co',start_date:'2024-11',end_date:'2026-10'},
      {job_title:'Previous role',employer:'Previous Co',start_date:'2023-03',end_date:'2024-11'},
      {job_title:'Older role',employer:'Older Co',start_date:'2022-07',end_date:'2022-09'}],
    education:[
      {institution:'Newest University',start_date:'2022-07'},
      {institution:'Previous College',start_date:'2020-04'},
      {institution:'Older School',start_date:'2010-04'}]}};
  const workEntry = number => `<div class="entry"><h3>Work Experience ${number}</h3>
    <label>Job Title<input class="title"></label><label>Company<input class="company"></label>
    <div data-automation-id="formField-startDate"><span data-automation-id="formLabel">From*</span>
      <input class="from" aria-label="MM/YYYY" placeholder="MM/YYYY"></div>
    <div data-automation-id="formField-endDate"><span data-automation-id="formLabel">To*</span>
      <input class="to" aria-label="MM/YYYY" placeholder="MM/YYYY"></div></div>`;
  const educationEntry = number => `<div class="entry"><h3>Education ${number}</h3>
    <label>Institution<input class="institution"></label><label>Degree<input></label></div>`;
  const {browser,page} = await browserPage(`<form><h1>My Experience</h1>
    <section id="work"><h2>Work Experience</h2>${workEntry(1)}
      <label>Section notes<input></label>${workEntry(2)}</section>
    <section id="education"><h2>Education</h2>${educationEntry(1)}
      <label>Section notes<input></label>${educationEntry(2)}</section></form>`,
    'https://tenant.myworkdayjobs.com/application', testProfile);
  try {
    await page.addScriptTag({path:asset('successfactors-core.js')});
    await page.addScriptTag({path:asset('successfactors-autofill.js')});
    await page.waitForFunction(() => document.querySelectorAll('#work .title')[1].value === 'Previous role'
      && document.querySelectorAll('#work .to')[1].value === '11/2024'
      && document.querySelectorAll('#education .institution')[1].value === 'Previous College');
    assert.deepEqual(await page.locator('#work .title').evaluateAll(inputs => inputs.map(input => input.value)),
      ['Newest role','Previous role']);
    assert.deepEqual(await page.locator('#work .from').evaluateAll(inputs => inputs.map(input => input.value)),
      ['11/2024','03/2023']);
    assert.deepEqual(await page.locator('#work .to').evaluateAll(inputs => inputs.map(input => input.value)),
      ['10/2026','11/2024']);
    assert.deepEqual(await page.locator('#education .institution').evaluateAll(inputs => inputs.map(input => input.value)),
      ['Newest University','Previous College']);
  } finally {await browser.close();}
});
test('profile editor saves unchanged history as dynamic defaults, not frozen overrides', async () => {
  const {browser,page} = await browserPage(fs.readFileSync(asset('autofill-profile.html'),'utf8').replace('<script src="autofill-profile.js"></script>',''),'https://local.invalid/profile');
  try {
    await page.evaluate(()=>{testData.profile={...testData.defaults};});
    await page.addScriptTag({path:asset('autofill-profile.js')});
    await page.waitForSelector('#education input');
    assert.deepEqual(await page.evaluate(() => [lastProfileRequest.url, lastProfileRequest.headers['X-Job-Assistant-Extension']]),
      ['http://127.0.0.1:8767/api/autofill-profile', 'test']);
    await page.locator('[type="submit"]').click();
    await page.waitForFunction(()=>!!window.saved);
    assert.equal(await page.evaluate(()=>Object.keys(saved.overrides).length),0);
    await page.locator('[data-key="first_name"]').fill('Alex');
    await page.locator('[type="submit"]').click();
    await page.waitForFunction(()=>saved.overrides.first_name==='Alex');
    assert.equal(await page.evaluate(()=>saved.base_storage_revision),'storage-one');
  } finally {await browser.close();}
});
test('profile editor blocks saving during load and reveals saved values only after success', async () => {
  const {browser,page} = await browserPage(fs.readFileSync(asset('autofill-profile.html'),'utf8').replace('<script src="autofill-profile.js"></script>',''),'https://local.invalid/profile');
  try {
    await page.evaluate(()=>{
      testData.overrides={prefix:'Mr.'}; testData.profile={...testData.profile,prefix:'Mr.'};
      window.fetch=()=>new Promise(resolve=>window.finishLoading=()=>resolve({ok:true,json:async()=>testData}));
    });
    await page.addScriptTag({path:asset('autofill-profile.js')});
    assert.equal(await page.locator('#autofill-form').isHidden(),true);
    assert.equal(await page.locator('#save-profile').isDisabled(),true);
    assert.equal(await page.locator('#status').textContent(),'Connecting to the local assistant…');
    await page.evaluate(()=>document.querySelector('#autofill-form').dispatchEvent(new Event('submit',{cancelable:true})));
    assert.equal(await page.locator('#status').textContent(),'Wait for your saved answers to load before saving.');
    await page.evaluate(()=>window.finishLoading());
    await page.waitForFunction(()=>document.querySelector('[data-key="prefix"]')?.value==='Mr.');
    assert.equal(await page.locator('#autofill-form').isVisible(),true);
    assert.equal(await page.locator('#save-profile').isEnabled(),true);
    assert.equal(await page.locator('#contact-fields').getByText('Your saved value').count(),1);
  } finally {await browser.close();}
});
test('profile editor keeps the form closed when loading fails', async () => {
  const {browser,page} = await browserPage(fs.readFileSync(asset('autofill-profile.html'),'utf8').replace('<script src="autofill-profile.js"></script>',''),'https://local.invalid/profile');
  try {
    await page.evaluate(()=>{window.fetch=async()=>({ok:false,json:async()=>({ok:false,error:'Local assistant is unavailable.'})});});
    await page.addScriptTag({path:asset('autofill-profile.js')});
    await page.waitForFunction(()=>!document.querySelector('#retry-load').hidden);
    assert.equal(await page.locator('#autofill-form').isHidden(),true);
    assert.equal(await page.locator('#save-profile').isDisabled(),true);
    assert.match(await page.locator('#load-status').textContent(),/Do not re-enter or save details/);
  } finally {await browser.close();}
});
test('dashboard refresh adds rows outside editors, defers inside editors, and preserves unsaved notes', async () => {
  const row = (id,title) => `<tr data-job-row data-id="${id}"><td data-sort="${id}">${title}<details><summary>Details</summary><textarea class="tracking-notes" data-id="${id}"></textarea></details><input class="follow-up-date" data-id="${id}" data-saved-value="" type="date" min="2000-01-01"><button>Review</button></td></tr>`;
  const html = (revision,rows) => `<meta name="jobs-revision" content="${revision}"><header><p>Jobs</p></header><button id="rematch">Rematch</button><p id="dashboard-status"></p><table><tbody>${rows}</tbody></table>`;
  const {browser,page} = await browserPage(html('one',row(1,'First')),'http://127.0.0.1:8767/');
  try {
    let revision='one',rows=row(1,'First');
    await page.unroute('**/*');
    await page.route('**/*', route => route.fulfill({contentType:route.request().url().endsWith('/api/jobs')?'application/json':'text/html',body:route.request().url().endsWith('/api/jobs')?JSON.stringify({ok:true,revision}):html(revision,rows)}));
    await page.addScriptTag({path:path.join(__dirname,'dashboard.js')});
    await page.locator('tbody button').focus();
    revision='two';rows+=row(2,'Second');
    await page.waitForSelector('[data-id="2"][data-job-row]');
    await page.locator('summary').first().click();
    await page.locator('textarea').first().fill('Unsaved note');
    await page.locator('textarea').first().blur();
    revision='three';rows+=row(3,'Third');
    await page.waitForSelector('[data-id="3"][data-job-row]');
    assert.equal(await page.locator('textarea').first().inputValue(),'Unsaved note');
    await page.locator('.follow-up-date').first().focus();
    revision='four';rows+=row(4,'Fourth');
    await page.waitForTimeout(1800);
    assert.equal(await page.locator('[data-id="4"][data-job-row]').count(),0);
    assert.equal(await page.evaluate(()=>document.activeElement.classList.contains('follow-up-date')),true);
    await page.locator('.follow-up-date').first().blur();
    await page.waitForSelector('[data-id="4"][data-job-row]');
  } finally {await browser.close();}
});
test('dashboard waits for a complete follow-up year and saves without disabling the editor', async () => {
  const row = `<tr data-job-row data-id="101"><td data-sort="101">Example</td><td><input id="follow-up" class="follow-up-date" data-id="101" data-saved-value="" type="date" min="2000-01-01"></td></tr>`;
  const html = `<meta name="jobs-revision" content="one"><header><p>Jobs</p></header><button id="rematch">Rematch</button><p id="dashboard-status"></p><table><tbody>${row}</tbody></table>`;
  const {browser,page} = await browserPage(html,'http://127.0.0.1:8767/');
  const posts = [];
  try {
    await page.unroute('**/*');
    await page.route('**/*', route => {
      const request = route.request();
      if (request.url().endsWith('/api/jobs/101/tracking')) {
        posts.push(JSON.parse(request.postData()));
        return route.fulfill({contentType:'application/json',body:JSON.stringify({ok:true})});
      }
      if (request.url().endsWith('/api/jobs')) return route.fulfill({contentType:'application/json',body:JSON.stringify({ok:true,revision:'one'})});
      return route.fulfill({contentType:'text/html',body:html});
    });
    await page.addScriptTag({path:path.join(__dirname,'dashboard.js')});
    await page.locator('#follow-up').focus();
    await page.locator('#follow-up').evaluate(control => {control.value='0002-09-12';control.dispatchEvent(new Event('input',{bubbles:true}));});
    await page.waitForTimeout(900);
    assert.equal(posts.length,0);
    await page.locator('#follow-up').evaluate(control => {control.value='2026-09-12';control.dispatchEvent(new Event('input',{bubbles:true}));});
    await page.waitForTimeout(900);
    assert.deepEqual(posts,[{follow_up_date:'2026-09-12'}]);
    assert.equal(await page.locator('#follow-up').isDisabled(),false);
    assert.equal(await page.evaluate(()=>document.activeElement.id),'follow-up');
  } finally {await browser.close();}
});
