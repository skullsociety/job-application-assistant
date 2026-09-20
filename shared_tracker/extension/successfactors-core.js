"use strict";
(() => {
  const norm = value => String(value || '').replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const supported = host => /(^|\.)(myworkdayjobs\.com|successfactors\.(com|eu)|sapsf\.(com|eu|cn)|hr\.cloud\.sap|jobs\.hr\.cloud\.sap\.com)$/.test(String(host).toLowerCase());
  const skillsLabel = label => /^(?:type to add |add )?(?:key |technical |core )?skills?(?: and competencies)?$/.test(norm(label));
  const multiValueLabel = label => /^(?:additional nationalit(?:y|ies))$/.test(norm(label));
  const protectedQuestion = label => /\b(password|verification|one time|captcha|consent|declare|declaration|certify|agree|terms and conditions|national id|nric number|passport number|criminal|medical|disability|conflict of interest)\b/.test(norm(label));
  function answer(label, section, index, data) {
    const key = norm(label), profile = data.profile || {};
    const exactSaved = (data.custom_answers || []).find(item => norm(item.question) === key);
    if (exactSaved && !/\b(password|verification|captcha|consent|declaration|certify|agree|terms and conditions|national id|nric number|passport number)\b/.test(key)) return exactSaved.answer;
    // Consent is filled only from an explicit saved choice. It is never inferred
    // from a resume, citizenship or another answer.
    const explicit = [
      [/personal data processed.*other positions|recruitment for other positions/, 'future_recruitment_consent'],
      [/consent to receive communication|job related events|event communications/, 'communications_consent'],
      [/criminal|convicted|prosecution|regulatory proceeding/, 'criminal_record'],
      [/dismissed|disciplinary|misconduct/, 'disciplinary_history'],
      [/financial interest/, 'financial_interest'],
      [/outside (?:employment|business)|external business|other employment/, 'outside_employment_or_business'],
      [/i hereby|certif(?:y|ication)|application declaration|agree to all/, 'declaration_acknowledgement'],
    ];
    for (const [regex, field] of explicit) if (regex.test(key)) return profile[field] || null;
    if (protectedQuestion(key)) return null;
    const saved = (data.custom_answers || []).find(item => norm(item.question) === key);
    if (saved) return saved.answer;
    // These are distinct facts, not variants of the applicant's contact details.
    if (/\b(referee|reference contact|emergency contact|spouse|parent|supervisor|manager name|phone country code|dialling code|dialing code|phone ext|phone extension|telephone ext|telephone extension|extension number)\b/.test(key)) return null;
    const item = (profile[section] || [])[index];
    const match = matcher => typeof matcher === 'function' ? matcher(key) : matcher.test(key);
    if (section === 'education' && item) {
      if (match(/\b(school|institution|university|college|institute)( name)?\b/)) return item.institution;
      if (match(/\b(major|field of study|speciali[sz]ation|discipline|subject)\b/)) return item.field_of_study;
      if (match(/\b(degree|qualification|education level|course|program(?:me)?)\b/)) return item.qualification;
      if (match(/\b(gpa|grade|result|class of hono[u]?rs)\b/)) return item.grade;
    }
    if (section === 'employment' && item) {
      if (match(/^(?:location|work location|job location)$/)) return item.country || profile.employment_location || null;
      if (match(/\b(currently (?:work|employ)|current (?:job|employment)|still employed|i (?:currently )?work here)\b/) && !match(/\b(name|title)\b/)) return !!item.current;
      if (match(/\b(employer|company|organi[sz]ation)( name)?\b/)) return item.employer;
      if (match(/\b(responsibilities|duties|description|achievements)\b/)) return item.description;
      if (match(/\b(job title|position|designation|role|title)\b/)) return item.job_title;
      if (match(/\b(reason for leaving|reason for separation)\b/)) return item.reason_for_leaving;
      if (match(/\bsalary\b/)) return item.salary;
    }
    if (item) {
      if (match(/\bcountry\b/)) return item.country;
      if (match(/\b(start|from|commencement|enrolment|enrollment|admission)( date| year| month)?\b/)) return datePart(item.start_date, key);
      if (match(/\b(end|to|completion|graduation)( date| year| month)?\b/)) return datePart(item.end_date, key);
      return null; // Never put a contact value into an unrelated history field.
    }
    const fields = [
      [/\b(prefix|salutation|honorific)\b/, 'prefix'],
      [/\b(first name|given name|forename)\b/, 'first_name'], [/\b(last name|family name|surname)\b/, 'last_name'],
      [/\b(full name|legal name|name as (?:per|in))\b/, 'full_name'],
      [/\b(email|e mail)( address)?\b/, 'email'], [/\bphone device type\b|\bdevice type\b/, 'phone_device_type'],
      [/\b(mobile|cell phone|cellphone|phone|telephone)( number)?\b/, 'phone'],
      [/\blinked ?in(?: website| url)?\b/, 'linkedin_url'], [/\bwebsite\s*2\b|\bsecond website\b/, 'website_url_2'],
      [/\bwebsite\s*1\b|\bfirst website\b|\bportfolio\b|\bpersonal site\b|^website$/, 'website_url'],
      [/\b(expected|desired)( monthly| annual)? (?:salary|remuneration|pay)\b/, 'expected_salary'],
      [/\bcurrent.*(?:monthly|base).*salary|\blast drawn.*base salary/, 'current_monthly_base_salary'],
      [/\bcurrent.*annual bonus|\blast drawn.*total bonus/, 'current_annual_bonus'],
      [/\bcurrent.*(?:variable|additional).*(?:income|compensation|bonus)/, 'current_variable_compensation'],
      [/\b(salary currency|currency)\b/, 'salary_currency'],
      [/\b(earliest|available|availability).*start date\b/, 'earliest_available_start_date'],
      [/\bnotice.*(?:current employer|before leaving)|\bnotice period\b/, 'notice_period'],
      [/\bdate of birth\b|\bbirth date\b/, 'date_of_birth'], [/\bcountry(?: territory)? of birth\b|\bbirth country\b/, 'country_of_birth'],
      [/\bgender\b|\bsex\b/, 'gender'], [/\brace\b|\bethnicity\b|\bethnic group\b/, 'ethnicity'], [/\breligion\b/, 'religion'],
      [/\badditional nationalit(?:y|ies)\b/, 'additional_nationalities'], [/\bprimary nationality\b|\bnationality\b/, 'nationality'],
      [/right to work.*singapore.*status/, 'citizenship'],
      [/\bcitizenship\b/, 'citizenship'],
      [/legally authori[sz]ed to work|authori[sz]ation to work|right to work/, 'work_authorized'],
      [/how many years of (?:working|work) experience|total years of (?:working|work) experience/, 'years_work_experience'],
      [/sponsor.*(?:visa|work authori[sz]ation)|need.*sponsorship|require.*sponsorship/, 'requires_sponsorship'],
      [/\bcountry(?: of residence)?\b/, 'country'],
      [/\b(city|town)\b/, 'city'], [/\b(address line 2|additional address|address 2)\b/, 'additional_address'],
      [/\b(address line 1|street name|street address|residential address|mailing address)\b|^address$/, 'street_name'],
      [/\b(postal code|zip code|postcode)\b/, 'postal_code'],
      [/hold.*(?:professional certifications?|clearance)|certifications?.*outlined.*job description/, 'holds_required_credentials'],
      [/willing.*able.*travel|willingness to travel/, 'willing_to_travel'],
      [/related to.*(?:partner|principal|employee)|relationship to.*employee/, 'related_to_employer'],
      [/relatives?.*(?:employed|working).*(?:organisation|organization|company|firm)|related person.*working/, 'relatives_at_employer'],
      [/professional bod|social.*sport.*organi[sz]ation|membership/, 'professional_memberships'],
      [/preferred.*office location|office location preference/, 'preferred_office_location'],
      [/how did you hear|source of application|recruitment source|referral source/, 'referral_source'],
      [skillsLabel, 'skills'],
      [/\b(professional summary|profile summary|career summary)\b/, 'summary'], [/^certifications?$/, 'certifications'],
    ];
    for (const [regex, field] of fields) if (match(regex)) {
      // Monthly and annual pay are different facts; never substitute one for the other.
      if (field === 'expected_salary' && /annual|yearly|per year/.test(key)) return null;
      return profile[field];
    }
    return null;
  }
  function datePart(value, key) {
    if (!value) return '';
    if (/\byear\b/.test(key)) return value.slice(0,4);
    if (/\bmonth\b/.test(key)) return value.slice(5,7);
    if (/\bday\b/.test(key)) return value.length === 10 ? value.slice(8,10) : '';
    return value;
  }
  function optionMatch(label, value) {
    const left = norm(label), right = norm(typeof value === 'boolean' ? value ? 'Yes' : 'No' : value);
    if (left === right) return true;
    const groups = [['singapore', 'singaporean'], ['citizen singapore', 'singapore citizen'], ['within one month', 'one month', '1 month']];
    return groups.some(group => group.includes(left) && group.includes(right));
  }
  function degreeMatch(label, value) {
    const degree = norm(value), option = norm(label);
    if (/\bbachelor\b/.test(degree)) return option === (/honours|honors/.test(degree) ? 'bachelor degree honours' : 'bachelor degree');
    if (/^diploma\b/.test(degree)) return option === 'diploma professional diploma';
    if (/\bmaster(?:s)?\b/.test(degree)) return option === 'masters';
    if (/\b(phd|doctorate|doctor of)\b/.test(degree)) return option === 'doctorate';
    return false;
  }
  const api = {norm, supported, skillsLabel, multiValueLabel, answer, protectedQuestion, optionMatch, degreeMatch, datePart};
  globalThis.SuccessFactorsCore = api;
  if (typeof module !== 'undefined') module.exports = api;
})();
