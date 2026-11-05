# Provenance

Where each part of the Paperhaus kit comes from. Paperhaus is a fork of BentoPDF (AGPL-3.0). This repository is public, which meets the license's source terms.

| Part | Origin | License |
| --- | --- | --- |
| BentoPDF app (everything outside `kit/`, `functions/`, `website/`) | Forked from BentoPDF | AGPL-3.0 |
| `kit/build.mjs`, `kit/theme/`, `kit/tools/pin/` | Written for Paperhaus | Same as the repo |
| `kit/tools/scan/` | Written for Paperhaus | Same as the repo |
| `kit/tools/esign/`, `functions/api/esign/` | Written for Paperhaus from its own design | Same as the repo |
| `kit/tools/more/` (PDF to PowerPoint, HTML to PDF, Redact PDF, Summarize PDF, Translate PDF), `functions/api/fetch.js` | Written for Paperhaus from a clean-room spec ("Paperhaus vs iLovePDF: gaps and build spec", Nov 4, 2026). Only iLovePDF's public tool names and one-line descriptions were looked at. No iLovePDF code, files, screens, wording, icons or name were used. Their terms forbid reverse engineering, and none was done. | Same as the repo |
| `pptxgenjs` 3.12.0 (PDF to PowerPoint) | npm package, installed at build time without saving | MIT |
| `html2canvas`, `pdf-lib`, `pdfjs-dist`, PyMuPDF (MuPDF) | Already shipped by BentoPDF | MIT, MIT/Apache-2.0, Apache-2.0, AGPL-3.0 |
| Chrome Summarizer, Translator and Language Detector APIs | Built into the user's browser, called at run time | Not shipped |
