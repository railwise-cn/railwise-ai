# Final 0.5.3 normal-mode acceptance protection

Prepared 2026-10-08. This document prepares reversible local acceptance; it does not claim the final package has passed acceptance. Single-maintainer release rules have already been approved and implemented. No second GitHub maintainer, new OS account, new Keychain identity, or professional human signature is introduced here.

## Scope and original state

The final installed package must retain public bundle identity `com.wangjiawei508.workgpt` and version `0.5.3`, without candidate or updater override environment variables. The script recomputes pack targets from that actual installed package and records its ASAR and manifest hashes. The previous freeze from `d3f9158a6fd26cd40e4f0bd3dd4d92e4686d1f51` / run `37749218440` was canceled; product remediation awaits its source PR and a new freeze. No replacement source or final package identity is recorded here. Source and package identity must be bound by the actual new main acceptance report before live activation; this procedure remains preparation, not completed activation or package acceptance.

The main agent has normally quit the application and confirmed no corresponding package processes. CUA observed System Settings > General > Login Items on 2026-10-08: RailWise is absent from Open at Login, and RailWise AI background activity is enabled. Existing application behavior has `openAtLogin`, `startMinimized`, and `closeToTray` all false. Private original AX/screenshot evidence lives under `/private/tmp/railwise-053-public-profile-guard/`; do not commit the entire personal application list.

The protection scope is the application's real `.workwise`, current RailWise AI userData, updater/application caches, logs/saved-state roots, its macOS preferences domain, and the finite agent-pack target union. It does not copy or move the entire `.codex`, legacy `.kun`/old userData, other projects, plugin/config catalogs, shared Keychain, TCC, or the background-task database.

## Migration and shared asset controls

- Precreate `.workwise/runtime`, `default_workspace`, `claw`, and `write_workspace`. Existing empty targets prevent home-data migration from legacy roots.
- Write a genuine fresh `workwise-settings.json` before launch. A marker alone cannot stop fallback reads from old sibling settings profiles.
- Set fresh workspace/runtime/write paths explicitly; disable IM and schedules. Only synthetic/public input and fresh export paths are used.
- If real AI acceptance needs the already authorized DeepSeek credential, `activate --reuse-deepseek` copies only the official DeepSeek provider fields from the private snapshot. It never prints them, copies other credentials, or changes a shared Keychain item. Normal application SafeStorage/Keychain behavior remains permitted.
- Recompute audited packaged assets from the installed package. Add asset destinations from both modern and legacy installed manifests, modern/legacy file metadata, both manifests and their durable backup sidecars. Whole Skill-directory copies preserve internal metadata. Reject symlinks and targets outside each declared Codex asset layout. Previously absent items retain their absence on restoration.
- Original application roots are atomically held in the private session; a verified independent `ditto --rsrc --extattr --acl` snapshot also exists. Pack copies preserve resource forks, extended attributes, ACLs and modes. Restoration verifies every file's content, size, mode and uid/gid plus recorded path presence/absence; originals moved by rename also retain their original metadata. The script does not claim its content/mode fingerprint separately verifies every ACL/xattr value.
- New matching installer temporary items are archived after the application stops. Existing temporary items are retained. Only journaled pack targets and metadata are restored; unrelated Codex files remain untouched.

## Executable sequence

Use a **new** private session directory inside `~/Library/Application Support/RailWise Acceptance/`. Backups contain real user data and credentials, so keep the directory private and out of Git. Command output excludes settings and process arguments. `inventory` is the default and makes no changes.

```sh
node docs/qa/release-gates/v0.5.3/normal-profile-protection.mjs inventory \
  --installed-app '/Applications/RailWise AI.app'

node docs/qa/release-gates/v0.5.3/normal-profile-protection.mjs snapshot \
  --installed-app '/Applications/RailWise AI.app' \
  --session '/Users/wangjiawei/Library/Application Support/RailWise Acceptance/053-final-normal-20261008' \
  --login-open-at-login false \
  --login-before-evidence '/private/tmp/railwise-053-public-profile-guard/login-items-before.ax.txt'

node docs/qa/release-gates/v0.5.3/normal-profile-protection.mjs activate \
  --installed-app '/Applications/RailWise AI.app' \
  --session '/Users/wangjiawei/Library/Application Support/RailWise Acceptance/053-final-normal-20261008' \
  --reuse-deepseek
```

`snapshot`, `activate`, `restore`, and `verify` reject active RailWise package/service processes and occupied normal application ports; no processes are killed automatically. They share an exclusive operation lock and one unresolved-session reservation. Do not run a competing application, asset install, or user edit against the protected targets during acceptance. A failed/partial activation preserves the journal and held originals; stop the application before `restore`. A snapshot interrupted before activation can use `abort-snapshot` with the same `--installed-app` and `--session`: it first verifies all original targets unchanged, retains the incomplete private snapshot, and releases only that unactivated reservation. Never remove the lock or active-session record just to bypass a failed operation. Pack restoration prepares a verified private staging copy and switches by rename; interrupted archival resumes from the journal without overwriting archived data.

If the operation was terminated and left an operation lock, use `recover-lock` with the same installed app and session. It requires a valid matching lock owner and an owner PID definitively absent (`ESRCH`), rejects a live/unknown owner or another reserved session, confirms the application stopped, and archives the stale lock with a recovery record. It does not change original data. Retry `abort-snapshot` or `restore` afterward. A missing/malformed lock owner requires read-only inspection and explicit manual recovery of that exact lock; do not remove a global lock without preserving evidence.

Journal writes sync their file before rename and sync the containing directory when the platform supports it. The tested recovery guarantee concerns process interruption. After power loss or filesystem failure, inspect the journal, held originals and independent snapshots before continuing; backup fingerprint mismatches block automated restoration.

The script does not launch the app. Launch the exact installed bundle normally through CUA/LaunchServices, verify actual profile paths, then run the entire frozen-package functional/visual checklist. Keep all created projects, native Save locations and fault-injection copies inside the fresh workspace. Real account Skills can still be discovered read-only, and the OS may use the application's normal Keychain identity; this is not a claim of zero account reads.

After final acceptance, quit the exact package normally and confirm all its services stop:

```sh
node docs/qa/release-gates/v0.5.3/normal-profile-protection.mjs restore \
  --installed-app '/Applications/RailWise AI.app' \
  --session '/Users/wangjiawei/Library/Application Support/RailWise Acceptance/053-final-normal-20261008'
```

This archives acceptance-created data, restores original roots and exact pack targets, and imports the original preferences domain. It checks preferences by canonical plist contents, rather than requiring identical serialization bytes; the original raw plist remains preserved. Defaults import cannot restore login items.

CUA must then verify Open at Login still has no RailWise item and RailWise AI background activity is still enabled. If necessary restore only that exact item/toggle. Preserve a fresh private AX/screenshot and explicitly compare with the before state, then finalize the data restoration journal:

```sh
node docs/qa/release-gates/v0.5.3/normal-profile-protection.mjs verify \
  --installed-app '/Applications/RailWise AI.app' \
  --session '/Users/wangjiawei/Library/Application Support/RailWise Acceptance/053-final-normal-20261008' \
  --login-after-evidence '/private/tmp/railwise-053-public-profile-guard/login-items-after.ax.txt'
```

`verify` binds the CUA evidence and rechecks original data; the agent's comparison of those screenshots/AX is required. It does not infer login-item equality from an arbitrary evidence file, nor does it certify product acceptance. Do not kill shared `cfprefsd`, reset the background-task database, or delete/rotate shared Keychain/TCC items.

## Verification boundary

`node docs/qa/release-gates/v0.5.3/normal-profile-protection.mjs self-test` exercises only temporary synthetic roots: changed originals block activation, unresolved sessions block concurrent sessions, migration targets/settings are precreated, modern/legacy/obsolete assets restore, absent caches become absent again, unrelated Codex assets stay unchanged, preferences restore, and symlink escapes fail. Fault checks cover interruption after snapshot journal, reservation, original-root move, asset archive and incomplete restoration copy; dead operation locks can be recovered while live owners are rejected. It does not touch the real profile, launch a package, supply a real updater test, or close any product-acceptance task.

The full final-package workflow remains defined in `docs/qa/evidence/railwise-next-private-cua-plan-20261006/README.md` and its execution checklist. Its older phrase prohibiting all retained credential access is narrowed here by the current explicit authorization: only the existing approved DeepSeek provider and normal application Keychain access may be reused. Original real projects/MCP credentials remain excluded from acceptance.
