# AI read-only startup diagnostic

Package: RailWise AI 0.5.3, freeze run 37921487940 attempt 1, source 6bcfe0db516eafbecfed546e7077088975cda804, installed ASAR 2134c273af4b7e86e6f0243b0178fd1ffedeb120f260bca7094b5726b7474af7. Parent UI PID 64797; fresh protected profile session 053-final-normal-37921487940-20261009. This is a sanitized diagnostic, not a release or professional-signoff conclusion.

## Findings

1. There is no observed Runtime startup failure. PID 64975 is a child of UI PID 64797 and listens on 127.0.0.1:8899. `/health` returns HTTP 200 status=ok. Fresh runtime log lines 5–14 show spawn and completed startup; line 30 records the received ready marker at 13:56:58.634Z. Fresh application log has no connection failure.
2. 127.0.0.1:8788 belongs to primary UI PID 64797, not the managed Runtime child. `/health` there returns HTTP 404; this is not evidence that the Runtime is offline.
3. The fresh task and fresh engineering thread were created 44 ms apart: project_440db098-a100-4da0-b0ee-976cec8d4dd9 at 14:04:50.682Z, thr_mwg66yoe at 14:04:50.726Z. Stored metadata and GET readback agree on engineering domain, exact project ID, default workspace and idle status. No model content was read.
4. The packaged renderer implements the frozen source's binding rule. EngineeringAiCommandCenter.tsx lines 115–139 use ready connection and an exact active thread/domain/project/workspace match. EngineeringComposer.tsx lines 140–141 use Preparing only when connected but no matching timeline thread is supplied. Continue conversation appearing in the parent-observed sidebar confirms that a matching engineering thread exists in renderer thread state.
5. The first task capture has conflicting evidence: AX includes Preparing, while its original screenshot visibly shows Ask the agent…. Parent later observed sidebar selection making fresh AX show Ask the agent…. This does not establish a multi-minute product failure or an exact renderer root cause. Treat this capture as inconsistent, not proof of a failed acceptance.
6. Existing frozen-source regressions cover an old refresh resuming after new Survey thread creation with both no previous task and an existing task. Navigation, thread-action and composer tests passed 29/29. This rules out the already-fixed modeled stale selection race under those contracts, but cannot prove every live event interleaving.

## Actual follow-up and classification

Root reported a second fresh New task with initial AX Preparing. Clicking the composer and pasting a public synthetic acceptance question immediately yielded fresh AX Ask the agent and Send enabled. Sending actually displayed the user message, Processing survey data and a Stop control. The AI reply was still pending at report time, so this diagnostic makes no model-answer acceptance claim.

This actual interaction did not reproduce a persistent unavailable conversation. Classify the first capture as an observation mismatch / transient initial binding, preserving the contradictory evidence. Do not make a source change or reject the frozen package on an unproved multi-minute stuck state. Root should retain the actual second-task captures with the continuing acceptance record.

No UI automation, restart, settings/profile mutation, workflow dispatch or repository edit was performed by this diagnostic. Only sanitized evidence files were written under this private directory.
