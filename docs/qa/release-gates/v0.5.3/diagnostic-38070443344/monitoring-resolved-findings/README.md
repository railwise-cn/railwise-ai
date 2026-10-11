# Resolved monitoring findings shown as pending

Installed RailWise AI 0.5.3, private freeze 38070443344 attempt 1, source `4517bc06082258ec1a657163f2cba7a20db288a6`, ASAR `fcea9d600f9e19deeea2e7aa2baf2a12e5a1ef9ad60385f97d2d13e64a13d9bb` remains blocked from release.

After a real CSV import, project configuration to mm and threshold 10, and one normal UI recheck, the summary correctly showed zero blockers and zero warnings. The 19 retained historical findings all had `resolved` status in actual read-only records, but the table called them “Pending confirmation.” The screenshot, original accessibility text and independent AI triage preserve this contradiction. A subsequent calculation does not erase it.

The fix adds an explicit neutral “Resolved · retained history” disposition before the accepted/severity branches, in English and Chinese. It keeps original findings, source rows and exact evidence references intact. Actual open warnings and blockers retain their existing confirmation and source replacement behavior; accepted findings remain distinct from resolved history. There is no backend, migration or stored-data change.

Six bilingual regression cases failed before the fix and pass afterward; the full workspace DOM suite passes. Independent AI source review is separate from packaged UI acceptance. The next corrected final package must be installed and inspected under the already authorized contract; these diagnostic/source records never constitute a package pass, professional signoff or publication approval.
