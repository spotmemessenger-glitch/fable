# Apple / iOS skill set

Installed Claude Code skills for Apple-platform engineering. Every directory containing a
`SKILL.md` is a skill; Claude loads one on demand when its `description` matches the task.

## Sources

| Source | Installed as | License |
|---|---|---|
| [Nagarjuna2997/ios-agent-skill](https://github.com/Nagarjuna2997/ios-agent-skill) | `ios-agent-skill/` (+ `../agents/*.md`) | MIT |
| [rshankras/claude-code-apple-skills](https://github.com/rshankras/claude-code-apple-skills) | 183 skills: `ios/ macos/ swift/ swiftui/ swiftdata/ visionos/ watchos/ design/ testing/ generators/ product/ growth/ app-store/ apple-intelligence/ performance/ security/ legal/ monetization/ mapkit/ core-ml/ foundation/ shared/` | MIT |
| [Viniciuscarvalho/swift-code-reviewer-skill](https://github.com/Viniciuscarvalho/swift-code-reviewer-skill) | `swift-expert/ swiftui-expert-skill/ swiftui-ui-patterns/ swift-concurrency/ swift-testing/` | MIT (upstream content itself unlicensed — see `ATTRIBUTION-swift-code-reviewer.md`) |
| [kylehughes/the-unofficial-swift-programming-language-skill](https://github.com/kylehughes/the-unofficial-swift-programming-language-skill) | `programming-swift/` | see bundled LICENSE |
| [kylehughes/the-unofficial-swift-concurrency-migration-skill](https://github.com/kylehughes/the-unofficial-swift-concurrency-migration-skill) | `migrating-to-swift-concurrency/` | see bundled LICENSE |
| [devsemih/appstore-review-skill](https://github.com/devsemih/appstore-review-skill) | `appstore-review/` | MIT |
| [Wholiver/swiftui-design-skill](https://github.com/Wholiver/swiftui-design-skill) | `swiftui-design/` | MIT |
| [hmohamed01/swift-development](https://github.com/hmohamed01/swift-development) | `swift-development/` | none stated |
| [Terryc21/workflow-audit](https://github.com/Terryc21/workflow-audit) | `workflow-audit/` | Apache-2.0 |
| [greenstevester/fastlane-skill](https://github.com/greenstevester/fastlane-skill) | `fastlane/` — `setup-fastlane`, `match`, `beta`, `release`, `snapshot` | MIT |
| [ebuntario/apple-hig](https://github.com/ebuntario/apple-hig) | `apple-hig/` — 75 HIG reference docs, all six platforms | MIT |
| [Terryc21/radar-suite](https://github.com/Terryc21/radar-suite) | `radar-suite/` + `capstone-radar`, `data-model-radar`, `roundtrip-radar`, `time-bomb-radar`, `ui-path-radar`, `ui-enhancer-radar` | Apache-2.0 |
| [markgravity/app-tester-skill](https://github.com/markgravity/app-tester-skill) | `app-tester/` | MIT |

Three skills were renamed to clear duplicate `name:` frontmatter, which would otherwise make
skill selection ambiguous: `macos-app-planner`, `macos-coding-best-practices`,
`swift-language-core`.

## Deliberately not installed

- `google/skills`, `android/skills` — checked, no Apple content (Google Cloud and Android only).
- Upstream installers, agent mirror copies (`.cursorrules`, `.windsurfrules`, `GEMINI.md`, …),
  repo-maintenance hooks, and JS test runners: they configure their own repos, not this one.
- `ios-agent-skill`'s MCP server — needs a build step and an entry in `.mcp.json`; not wired up.
- `Jonnycatx/apple-full-stack-genius-skill` — duplicates coverage we already have, and its prompt
  instructs the agent to "jump straight into full project structure and working code — don't wait
  to be asked" behind a description that fires on any mention of iOS. That overrides asking before
  scaffolding, so it was left out on purpose rather than missed.

No skill exists on GitHub for **Metal/MetalFX, ARKit/RealityKit, HealthKit, HomeKit, CarPlay, or
SiriKit**, nor for **TCA, Alamofire, Firebase/Supabase Swift, GRDB, or Tuist** — searched by
keyword, by `topic:claude-skill`, and through the curated lists. The `ios-agent-skill/docs/frameworks`
tree is the only coverage for those.

## Specialist agents

`.claude/agents/` holds 10 subagents: `swift-reviewer`, `swift-refactorer`, `swift-debugger`,
`swiftui-modernization`, `performance-reviewer`, `accessibility-reviewer`, `foundation-models`,
`ios-plan`, `ios-explore`, `ios-docs`.
