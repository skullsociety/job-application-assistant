"use strict";
// Isolated synthetic forms only. Never connects to a real application or Chrome profile.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const {chromium} = require(require.resolve('playwright', {paths:[process.env.JOB_ASSISTANT_NODE_MODULES || path.join(__dirname,'../linkedin/node_modules')]}));
const asset = file => path.join(__dirname,'extension',file);
const profile = {ok:true,enabled:true,revision:'one',defaults:{full_name:'Alex Example',education:[{qualification:'Degree',institution:'Example University',end_date:'2020-06'}],employment:[]},overrides:{},custom_answers:[],source:{name:'example.pdf'},warnings:[],profile:{full_name:'Alex Example',first_name:'Alex',email:'alex@example.org',country:'Singapore',skills:'Python, SQL',education:[{institution:'Example University',qualification:'Degree',end_date:'2020-06'}],employment:[{employer:'Example Ltd',job_title:'Analyst',current:true},{employer:'Previous Ltd',job_title:'Engineer',current:false}]}};
async function browserPage(html, url = 'https://career.successfactors.com/application', testProfile = profile) {
  const browser = await chromium.launch({channel:'chrome', headless:true});
  const page = await browser.newPage();
  await page.route('**/*', route => route.fulfill({contentType:'text/html',body:html}));
  await page.goto(url);
  await page.evaluate(data => {window.testData=data;window.chrome={runtime:{id:'test',sendMessage:async message=>{if(message.type==='SAVE_SF_PROFILE'){window.saved=message.value;}return window.testData;}}};}, testProfile);
  return {browser,page};
}
test('fills text, real options, repeated history; skips unknown dates and existing answers', async () => {
  const {browser,page} = await browserPage(`<form><h1>Application</h1><label>First name<input id="first"></label><label>Email<input id="email" value="keep@example.org"></label><label>Country<select id="country"><option value="">Select One</option><option>Singapore</option></select></label>
  <fieldset><legend>Education</legend><label>Institution<input id="school"></label><label>Completion date<input type="date" id="date"></label></fieldset>
  <section><h2>Employment</h2><label>Employer<input id="employer1"></label><label>Job title<input id="title1"></label></section>
  <section><h2>Employment</h2><label>Employer<input id="employer2"></label><label>Job title<input id="title2"></label></section>
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
    assert.equal(await page.locator('#consent').isChecked(),false);
    assert.equal(await page.evaluate(()=>!!window.submitted),false);
    await page.locator('#first').fill('Manual');
    await page.evaluate(()=>SuccessFactorsAutofill.scan());
    assert.equal(await page.locator('#first').inputValue(),'Manual');
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
test('profile editor saves unchanged history as dynamic defaults, not frozen overrides', async () => {
  const {browser,page} = await browserPage(fs.readFileSync(asset('autofill-profile.html'),'utf8').replace('<script src="autofill-profile.js"></script>',''),'https://local.invalid/profile');
  try {
    await page.evaluate(()=>{testData.profile={...testData.defaults};});
    await page.addScriptTag({path:asset('autofill-profile.js')});
    await page.waitForSelector('#education input');
    await page.locator('[type="submit"]').click();
    await page.waitForFunction(()=>!!window.saved);
    assert.equal(await page.evaluate(()=>Object.keys(saved.overrides).length),0);
    await page.locator('[data-key="first_name"]').fill('Alex');
    await page.locator('[type="submit"]').click();
    await page.waitForFunction(()=>saved.overrides.first_name==='Alex');
  } finally {await browser.close();}
});
test('profile editor shows manual fields immediately while the local assistant is still connecting', async () => {
  const {browser,page} = await browserPage(fs.readFileSync(asset('autofill-profile.html'),'utf8').replace('<script src="autofill-profile.js"></script>',''),'https://local.invalid/profile');
  try {
    await page.evaluate(()=>{chrome.runtime.sendMessage=()=>new Promise(()=>{});});
    await page.addScriptTag({path:asset('autofill-profile.js')});
    await page.waitForSelector('#contact-fields [data-key="first_name"]');
    assert.equal(await page.locator('#source').textContent(),'No source resume found.');
    assert.equal(await page.locator('#status').textContent(),'Connecting to the local assistant…');
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
