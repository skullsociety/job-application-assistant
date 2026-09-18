"""One private, editable profile shared by the three Chrome extensions."""
from __future__ import annotations

import hashlib
import json
import threading
from datetime import date
from pathlib import Path
from uuid import uuid4
from .schema import LOCAL_DATA, WORKSPACE
from .resume_profile import newest_resume, read_resume, parse_resume

PROFILE_PATH = LOCAL_DATA / 'private/autofill-profile.local.json'
# Only facts explicitly extracted from the newest resume become defaults.
# Application choices, name order, salary and dates that need inference stay manual.
RESUME_DEFAULT_FIELDS = frozenset({
    'full_name', 'email', 'phone', 'linkedin_url', 'website_url', 'website_url_2',
    'street_name', 'additional_address', 'city', 'postal_code', 'country',
    'summary', 'skills', 'certifications', 'education', 'employment',
})
TEXT_FIELDS = ('prefix','full_name','first_name','last_name','email','phone','phone_device_type','country','city',
               'street_name','additional_address','address_line1','postal_code','linkedin_url','website_url','website_url_2',
               'expected_salary','salary_currency','notice_period','gender','date_of_birth','country_of_birth','ethnicity',
               'religion','nationality','additional_nationalities',
               'citizenship','work_authorized','requires_sponsorship','holds_required_credentials','willing_to_travel',
               'earliest_available_start_date','related_to_employer','future_recruitment_consent','communications_consent',
               'current_monthly_base_salary','current_annual_bonus','current_variable_compensation','preferred_office_location',
               'professional_memberships','financial_interest','outside_employment_or_business','disciplinary_history',
               'criminal_record','relatives_at_employer','referral_source','declaration_acknowledgement',
               'summary','skills','certifications')
_lock = threading.RLock()
_cache = {}


def allowed_extension(origin: str) -> bool:
    manifest = WORKSPACE / 'chrome-helper/generated/com.job_application_assistant.launcher.json'
    try: allowed = json.loads(manifest.read_text(encoding='utf-8'))['allowed_origins']
    except (OSError, ValueError, KeyError): return False
    return origin.rstrip('/') + '/' in allowed and origin.startswith('chrome-extension://')


def allowed_extension_request(origin: str, extension_id: str) -> bool:
    """Accept privileged extension fetches that omit Origin, not web origins."""
    if origin:
        return allowed_extension(origin)
    if not extension_id or len(extension_id) != 32 or any(letter not in 'abcdefghijklmnop' for letter in extension_id):
        return False
    return allowed_extension('chrome-extension://' + extension_id)


def validate_saved(value: dict) -> dict:
    if not isinstance(value, dict) or set(value) - {'enabled', 'overrides', 'custom_answers'}:
        raise ValueError('Use the autofill profile form to edit these settings.')
    if not isinstance(value.get('enabled', True), bool): raise ValueError('Enabled must be true or false.')
    overrides = value.get('overrides', {})
    if not isinstance(overrides, dict) or set(overrides) - set(TEXT_FIELDS) - {'education','employment'}:
        raise ValueError('Unknown profile fields.')
    for key, item in overrides.items():
        if key in TEXT_FIELDS and (not isinstance(item, str) or len(item) > 20000): raise ValueError('Profile text is too long or invalid.')
        if key == 'prefix' and item not in {'', 'Dr.', 'Miss', 'Mr.', 'Mrs.', 'Ms.', 'Prof.'}:
            raise ValueError('Choose a supported prefix from the profile form.')
        if key == 'phone_device_type' and item not in {'', 'Mobile', 'Landline'}:
            raise ValueError('Phone device type must be Mobile or Landline.')
        if key in {'work_authorized','requires_sponsorship','holds_required_credentials','willing_to_travel',
                   'future_recruitment_consent','communications_consent'} and item not in {'', 'Yes', 'No'}:
            raise ValueError('Choose Yes, No or Not set for this application answer.')
        if key in {'financial_interest','outside_employment_or_business','disciplinary_history','criminal_record',
                   'declaration_acknowledgement'} and item not in {'', 'Yes', 'No', 'N/A'}:
            raise ValueError('Choose Yes, No, N/A or Not set for this application answer.')
        if key in {'earliest_available_start_date', 'date_of_birth'} and item:
            try: date.fromisoformat(item)
            except ValueError as exc: raise ValueError(f'{key.replace("_", " ").title()} must use YYYY-MM-DD.') from exc
        if key in {'education','employment'}:
            fields = {'institution','qualification','field_of_study','start_date','end_date','country','grade'} if key == 'education' else {'employer','job_title','start_date','end_date','current','description','country','reason_for_leaving','salary'}
            if not isinstance(item, list) or len(item) > 30: raise ValueError('Use at most 30 history entries.')
            for entry in item:
                if not isinstance(entry, dict) or set(entry) - fields: raise ValueError('Invalid history fields.')
                for field, val in entry.items():
                    if field == 'current':
                        if not isinstance(val, bool): raise ValueError('Current employment must be true or false.')
                    elif not isinstance(val, str) or len(val) > 20000: raise ValueError('Invalid history value.')
    answers = value.get('custom_answers', [])
    if not isinstance(answers, list) or len(answers) > 100: raise ValueError('Use at most 100 saved answers.')
    for answer in answers:
        if not isinstance(answer, dict) or set(answer) != {'question','answer'} or not all(isinstance(v, str) and len(v) <= 20000 for v in answer.values()):
            raise ValueError('Saved answers need a question and answer.')
    return {'enabled': value.get('enabled', True), 'overrides': overrides, 'custom_answers': answers}


def get_profile(path: Path = PROFILE_PATH, folders: list[Path] | None = None) -> dict:
    with _lock:
        saved = validate_saved(json.loads(path.read_text(encoding='utf-8'))) if path.exists() else validate_saved({})
        resume = newest_resume(folders if folders is not None else [LOCAL_DATA / 'resumes'])
        defaults, warnings, source = {}, [], None
        if resume:
            signature = (str(resume.resolve()), resume.stat().st_mtime_ns, resume.stat().st_size)
            if signature not in _cache:
                try:
                    text = read_resume(resume)
                    if not text.strip(): raise ValueError('This resume has no readable text (it may need OCR).')
                    _cache.clear()
                    _cache[signature] = parse_resume(text)
                except Exception as exc:
                    _cache[signature] = ({}, ['The newest resume could not be parsed: ' + str(exc)])
            extracted, warnings = _cache[signature]
            defaults = {key: value for key, value in extracted.items() if key in RESUME_DEFAULT_FIELDS}
            source = {'name': resume.name, 'modified_ns': signature[1]}
        else: warnings = ['Add a source PDF or DOCX resume to local-data/resumes.']
        effective = {**{key: '' for key in TEXT_FIELDS}, 'education': [], 'employment': [], **defaults, **saved['overrides']}
        if effective['first_name'] and effective['last_name']:
            warnings = [warning for warning in warnings if not warning.startswith('Given/family name order')]
        result = {**saved, 'defaults': defaults, 'profile': effective, 'source': source, 'warnings': warnings,
                  'storage_revision': _storage_revision(saved)}
        result['revision'] = hashlib.sha256(json.dumps(result, sort_keys=True).encode()).hexdigest()
        return result


def _storage_revision(saved: dict) -> str:
    """Track edits to saved answers independently of resume-derived defaults."""
    return hashlib.sha256(json.dumps(saved, sort_keys=True, ensure_ascii=False).encode('utf-8')).hexdigest()


def save_profile(value: dict, path: Path = PROFILE_PATH) -> dict:
    if not isinstance(value, dict):
        raise ValueError('Reload the autofill profile before saving.')
    base_revision = value.get('base_storage_revision')
    if not isinstance(base_revision, str) or len(base_revision) != 64:
        raise ValueError('Reload the autofill profile before saving. No changes were saved.')
    saved = validate_saved({key: item for key, item in value.items() if key != 'base_storage_revision'})
    with _lock:
        current = validate_saved(json.loads(path.read_text(encoding='utf-8'))) if path.exists() else validate_saved({})
        if _storage_revision(current) != base_revision:
            raise ValueError('The autofill profile changed in another tab. Reload it before saving. No changes were saved.')
        path.parent.mkdir(parents=True, exist_ok=True)
        temporary = path.with_name('.profile-' + uuid4().hex + '.tmp')
        backup_temporary = path.with_name('.profile-backup-' + uuid4().hex + '.tmp')
        try:
            temporary.write_text(json.dumps(saved, ensure_ascii=False, indent=2), encoding='utf-8')
            if path.exists():
                backup_temporary.write_bytes(path.read_bytes())
                backup_temporary.replace(path.with_name(path.name + '.bak'))
            temporary.replace(path)
        finally:
            temporary.unlink(missing_ok=True)
            backup_temporary.unlink(missing_ok=True)
    return get_profile(path)
