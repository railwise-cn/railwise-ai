# Isolated native updater acceptance — workflow 37316902321

This directory records the isolated Frontier-feed updater acceptance for RailWise AI 0.5.2 using the immutable public 0.5.1 installers as the baseline.

- Workflow: https://github.com/railwise-cn/railwise-ai/actions/runs/37316902321
- Target version: 0.5.2
- Baseline version: 0.5.1
- Feed: isolated Frontier feed for this run (removed by cleanup job after acceptance)
- Feed publication job: `Publish isolated target Frontier feed` (success)
- Feed metadata artifacts: `feed/`
- Native updater artifacts: uploaded by the workflow's three matrix jobs after each path completes

The three native paths are macOS Apple Silicon, macOS Intel, and Windows x64. The final acceptance gate and cleanup result will be recorded after the matrix jobs finish.
