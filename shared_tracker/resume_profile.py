"""Local, conservative resume extraction for editable application defaults.

No cloud calls. Partial dates stay partial; unknown facts stay blank.
"""
from __future__ import annotations

import re
from pathlib import Path

MONTHS = {name.lower(): str(i).zfill(2) for i, name in enumerate(
    ('Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'), 1)}
DATE = r'(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+\d{4}|\d{4}[-/]\d{2}(?:[-/]\d{2})?|\d{4}|Present|Current'
RANGE = re.compile(rf'(?P<start>{DATE})\s*[-–—�]\s*(?P<end>{DATE})', re.I)
HEADINGS = {
    'summary': r'professional summary|personal summary|profile|summary|career objective',
    'skills': r'core skills|technical skills|key skills|skills',
    'employment': r'professional experience|employment history|work experience|work history|experience',
    'education': r'education|academic qualifications|academic background|educational qualifications',
    'certifications': r'certifications(?: and professional development)?|professional development|certificates',
}


def clean(value: str) -> str:
    return re.sub(r'\s+', ' ', value).strip(' \t•')


def partial_date(value: str) -> str:
    value = clean(value)
    if re.fullmatch(r'present|current', value, re.I): return ''
    month = re.fullmatch(r'([A-Za-z]+)\s+(\d{4})', value)
    if month and month[1][:3].lower() in MONTHS:
        return month[2] + '-' + MONTHS[month[1][:3].lower()]
    if re.fullmatch(r'\d{4}(?:[-/]\d{2}(?:[-/]\d{2})?)?', value): return value.replace('/', '-')
    return ''


def read_resume(path: Path) -> str:
    if path.suffix.lower() == '.pdf':
        from pypdf import PdfReader
        reader = PdfReader(path)
        return '\n'.join(page.extract_text(extraction_mode='layout') or '' for page in reader.pages)
    from docx import Document
    document = Document(path)
    paragraphs = [p.text for p in document.paragraphs]
    for table in document.tables:
        paragraphs.extend(' | '.join(cell.text for cell in row.cells) for row in table.rows)
    return '\n'.join(paragraphs)


def newest_resume(folders: list[Path]) -> Path | None:
    candidates = [file for folder in folders if folder.is_dir() for file in folder.iterdir()
                  if file.is_file() and file.suffix.lower() in {'.pdf', '.docx'}
                  and not re.search(r'backup|tailored|^~\$', file.name, re.I)]
    return max(candidates, key=lambda file: (file.stat().st_mtime_ns, file.name), default=None)


def parse_resume(text: str) -> tuple[dict, list[str]]:
    sections = {key: [] for key in HEADINGS}
    sections['contact'] = []
    current = 'contact'
    for raw in text.splitlines():
        line = clean(raw)
        heading = next((key for key, pattern in HEADINGS.items() if re.fullmatch(pattern + r'\s*:?', line, re.I)), None)
        if heading: current = heading
        elif line: sections[current].append(line)
    contact_lines = sections['contact']
    contact = ' '.join(contact_lines)
    def labelled(pattern: str) -> str:
        for contact_line in contact_lines:
            match = re.fullmatch(rf'(?:{pattern})\s*:\s*(.+)', contact_line, re.I)
            if match: return clean(match[1])
        return ''
    email = re.search(r'[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}', contact)
    phone = re.search(r'(?<!\w)(?:\+\d{1,3}[\s-]?)?(?:\(?\d{2,4}\)?[\s-]?){2,4}(?!\w)', contact)
    phone_value = phone[0].strip() if phone and 8 <= len(re.sub(r'\D', '', phone[0])) <= 15 else ''
    linkedin = re.search(r'(?:https?://)?(?:www\.)?linkedin\.com/in/[\w-]+', contact, re.I)
    websites = [match[0] for match in re.finditer(r'(?:https?://)?[\w.-]+\.(?:github\.io|com|sg|net|org)(?:/[\w./-]*)?', contact, re.I)
                if not (email and match[0] in email[0]) and 'linkedin.com' not in match[0].lower()]
    websites = list(dict.fromkeys('https://' + value.removeprefix('https://').removeprefix('http://') for value in websites))
    name = sections['contact'][0] if sections['contact'] else ''
    if '@' in name or re.search(r'\d', name) or len(name.split()) > 6: name = ''
    defaults = {
        'full_name': name, 'first_name': '', 'last_name': '',
        'email': email[0] if email else '', 'phone': phone_value,
        'linkedin_url': ('https://' + linkedin[0].removeprefix('https://').removeprefix('http://')) if linkedin else '',
        'website_url': websites[0] if websites else '', 'website_url_2': websites[1] if len(websites) > 1 else '',
        'street_name': labelled(r'street name|street address|address line 1|address'),
        'additional_address': labelled(r'additional address|address line 2'),
        'city': labelled(r'city|town'), 'postal_code': labelled(r'postal code|postcode|zip code'),
        'summary': clean(' '.join(sections['summary'])).rstrip(' .'),
    }
    # Remove category headings, then keep the actual skill phrases.
    skill_groups = []
    for line in sections['skills']:
        if ':' in line:
            skill_groups.append(line.split(':', 1)[1].strip())
        elif skill_groups:
            skill_groups[-1] += ' ' + line
        else:
            skill_groups.append(line)
    skill_text = ', '.join(skill_groups)
    defaults['skills'] = ', '.join(dict.fromkeys(clean(skill) for skill in re.split(r'[,;]', skill_text) if clean(skill)))
    education = []
    for line in sections['education']:
        line = re.sub(r'^\d+[.)]\s*', '', line)
        # Common institution - qualification | completion-date format.
        parts = re.split(r'\s+[-–—]\s+', line, maxsplit=1)
        if len(parts) != 2: continue
        institution, remainder = parts
        qualification = remainder.split('|')[0].strip()
        dates = list(re.finditer(DATE, remainder, re.I))
        end_date = partial_date(dates[-1][0]) if dates else ''
        study = re.search(r'\b(?:in|of)\s+(.+)', qualification, re.I)
        field = study[1] if study else ''
        if ' in ' in qualification.lower(): field = re.split(r'\bin\s+', qualification, flags=re.I)[-1]
        education.append({'institution': institution, 'qualification': qualification, 'field_of_study': field,
                          'start_date': '', 'end_date': end_date, 'country': '', 'grade': ''})
    employment = []
    for line in sections['employment']:
        dates = RANGE.search(line)
        if dates:
            head = line[:dates.start()].strip()
            parts = head.split('|', 1)
            if len(parts) != 2:
                # A clearly named resident/training role is retained as experience,
                # not silently reclassified as salaried employment.
                role = re.search(r'\b(Data Science Immersive Resident|Software Engineer|Data Engineer|Data Analyst|Research Assistant)\b', head, re.I)
                if role: parts = [head[:role.start()].strip(), head[role.start():].strip()]
            if len(parts) == 2 and all(parts):
                employment.append({'employer': clean(parts[0]), 'job_title': clean(parts[1]),
                                   'start_date': partial_date(dates['start']), 'end_date': partial_date(dates['end']),
                                   'current': bool(re.fullmatch('present|current', dates['end'], re.I)),
                                   'description': '', 'country': '', 'reason_for_leaving': '', 'salary': ''})
        elif employment:
            line = re.sub(r'^\d+[.)]\s*', '', line)
            employment[-1]['description'] = clean(employment[-1]['description'] + ' ' + line)
    defaults['education'] = education
    defaults['employment'] = sorted(employment, key=lambda item: item['start_date'], reverse=True)
    defaults['certifications'] = '\n'.join(re.sub(r'^\d+[.)]\s*', '', line) for line in sections['certifications'])
    warnings = []
    if not name: warnings.append('Name could not be identified reliably.')
    warnings.append('Given/family name order is not inferred from a full name; confirm it in the profile.')
    if not education: warnings.append('No structured education entries were identified; add or correct them below.')
    if not employment: warnings.append('No structured employment entries were identified; add or correct them below.')
    if any(len(item['start_date']) < 10 or item['end_date'] and len(item['end_date']) < 10 for item in employment + education):
        warnings.append('Some dates have only a month/year. Exact days, grades, salaries and missing countries are not invented.')
    return defaults, warnings
