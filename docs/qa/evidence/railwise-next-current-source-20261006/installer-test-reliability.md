# Installer test reliability evidence — 2026-10-06

## Root cause

The failures were confined to four tests that copy and validate large recursive bundles:

- agent pack update
- WORKWISE bundled Skill migration into the agent pack
- obsolete agent pack layout cleanup
- bundled PPT Master slim Skill installation

Each completed in under one second when run alone or as a focused pair. In the desktop-wide Vitest run, forked file parallelism saturated filesystem and worker capacity, so these recursive installs exceeded Vitest's default 5,000 ms test timeout. The reported \`ENOTEMPTY\` errors were cleanup races after Vitest timed out the test while its asynchronous copy/replacement was still in flight; they were not independent install failures.

## Change

Added a 30,000 ms timeout only to those four tests:

- \`src/main/services/agent-pack-service.test.ts\`: \`BUNDLED_PACK_INSTALL_TIMEOUT_MS\`
- \`src/main/services/skill-service.test.ts\`: \`PPT_MASTER_INSTALL_TIMEOUT_MS\`

The default 5,000 ms timeout remains in force for every other test. No service behavior, global Vitest setting, version, or release metadata changed.

## Verification

- \`npx vitest run src/main/services/agent-pack-service.test.ts src/main/services/skill-service.test.ts --reporter=verbose\`
  - 2 files passed; 27 tests passed; 0 timeout or ENOTEMPTY failures.
- \`npx vitest run --reporter=dot\`
  - 352 files passed, 2 skipped; 3,151 tests passed, 2 skipped.
  - Duration: 35.69 s.
- \`git diff --check -- src/main/services/agent-pack-service.test.ts src/main/services/skill-service.test.ts\`
  - passed.

The full run above used the same local timeout change; increasing the local budget from 15,000 ms to the final 30,000 ms only increases the bounded failure budget and does not alter successful execution.

