# Careers@Gov adapter

This folder contains the Careers@Gov local service, capture parser, resume matching and tailored-resume adapter. Its browser module now lives in `extension/sites/careersgov` and is loaded through the unified extension documented in [the main guide](../README.md).

Load only the root `extension/` folder in Chrome. Sign-in, declarations, application review and submission remain manual.

If Careers@Gov returns `403 Forbidden` after many listing tabs have been opened, clear cookies and site data for `jobs.careers.gov.sg`, sign in again, and continue with fewer simultaneous listing tabs.
