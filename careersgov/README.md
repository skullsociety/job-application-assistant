# Careers@Gov adapter

This folder contains the Careers@Gov-specific Chrome extension, capture parser, resume matching and tailored-resume adapter. It uses the suite-wide data and Workday/SuccessFactors autofill components documented in [the main guide](../README.md).

Load `careersgov/extension` as an unpacked Chrome extension after running the suite setup. Sign-in, declarations, application review and submission remain manual.

If Careers@Gov returns `403 Forbidden` after many listing tabs have been opened, clear cookies and site data for `jobs.careers.gov.sg`, sign in again, and continue with fewer simultaneous listing tabs.
