# Real native updater round trip

Status: **passed for the actual same-frozen-package updater and stored synthetic-data scope**.

Exact package: RailWise AI 0.5.3, freeze run 38100786001 attempt 1, source `3256f4842503e002f094952934b82f2d1d445a0f`, arm64 DMG SHA256 `6b12d991bee1853f93ab13e37aee8cf9759ea17642252bf7e11fa11ea0b37c6e`, installed/frozen/updater ASAR SHA256 `2e18a357464957c304a7a7aeb040071845a9b0ddfc190257518604c55b739797`.

Workflow `frozen-release-updater-acceptance.yml`, run 38111109910 attempt 1, artifact 11691164360 (`frozen-updater-arm64-38111109910`, sha256:db28d0759e16153b5a3afc5f3531d556adb622414ffdbdff2469a85deb529df5) used the pinned official 0.5.2 base. Native updater stages actually started, detected 0.5.3, fully downloaded, requested install, relaunched 0.5.3 and read back preserved synthetic data after relaunch/restart. Browser was not opened. It used a private isolated candidate feed and did not promote Stable.

Original machine report `updater/frozen-updater.json` SHA256 `3659558f8d3101b8e834f082e12b28ff3439a318d3a4b81ee7f84879fb0609d5`; native report `updater/native-updater.json` SHA256 `9745c174e6ae6d0cb932da6d28670d36e6e99c0009b681e92d79fadefda1be66`. Both are retained byte-for-byte, with no reordered or substituted JSON. Actual native interval: 2026-10-11T04:25:57.811Z–04:26:52.128Z.

Installed updater target/frozen/UI ASAR values match exactly. Signature and stapled ticket verified; system Gatekeeper assessments locally disabled, so enabled-policy enforcement is not asserted. Synthetic IN2/CSV stored continuity and configuration references were read back; arbitrary legacy schema, live plugins/credential activation and vendor interoperability are not certified. This was a native updater test, not a manual website download or mocked updater.
