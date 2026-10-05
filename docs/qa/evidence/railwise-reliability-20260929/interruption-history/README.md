# Paused execution and history recovery

The exact 7fc5b9206057 target revealed that a failed execution could enter generic progress recovery, advertise consultation mutations and obscure its original plan with a new draft. The original needs-attention plan also lacked a typed-resume button.

The repair keeps a paused execution read-only, rejects in-turn plan/project replacement, gives its stop priority over generic continuation and subsequent model failure, and restores typed continuation of the same Task and successful receipts. A bounded, scoped history selector retrieves a specific plan without latest fallback or approving later drafts. Monitoring data/trend navigation follows the selected dataset/task; existing compatibility fields are preserved. Draft export cards wrap long paths/hashes and keep the status label readable.

Actual HTTP/Runtime tests inject a real ENOTDIR filesystem failure after preceding steps succeed, verify one Task attempt, deny mutations while its turn is active, restore the directory and explicitly resume the original Task. They also cover an unavailable explanatory model and an independently requested later draft. DOM tests select the original failed plan and confirm only its typed resume is submitted.

Final source validation logs are retained here. Installed-package UI, real-model recovery and supported visual states still require the next frozen private target; these source checks do not authorize a public release.
