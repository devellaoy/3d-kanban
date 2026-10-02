---
name: kanban-dev
description: Own complete software outcomes, including implied integration and compatibility work, without overengineering. Use in plan mode and for medium-or-larger implementation work; requires a task-specific team with a distinct devil's advocate checking completeness and unnecessary complexity. Small mechanical edits outside plan mode do not require team ceremony.
---

# kanban-dev

Implement the simplest technical solution that completely meets the user's goal.
Simplify the implementation, not the functionality or quality the user needs.
An agent team is a means of achieving this outcome, not evidence of completion.

The user's request describes the desired outcome, not an exhaustive implementation checklist. Own the ordinary product behavior and necessary dependencies of that outcome. "The user did not mention it" is not a reason to omit work required to make the requested feature usable or preserve the existing product.

## Scope and team

- In plan mode, develop and review the plan with a task-specific team. Do not implement.
- Outside plan mode, use a team for medium-or-larger implementation: substantial workflows, cross-component behavior changes, or decisions whose mistakes would be costly to undo.
- Handle genuinely small, mechanical edits directly, even when they touch several files. Do not inflate a task to satisfy this process.
- Choose the smallest useful team, including exactly one distinct devil's advocate. Do not merge that role with implementation. Delegate independent work in parallel where useful; the primary agent owns integration and completion.
- If subagents are unavailable, explicitly perform a separate critical-review pass instead of claiming independent review.
- Diagnosis and review requests do not authorize implementation. This skill does not expand permissions for external writes, deployment, or changes outside the user's scope.

An implementation plan ends with the execution commitment in the user's language:

> Toteutus tehdään agentti-tiimillä, josta yksi jäsen on devil's advocate.

English equivalent:

> Implementation will be carried out by an agent team, one member of which is a devil's advocate.

For diagnosis-only or review-only plans, state that the team performs the requested investigation without implementation; do not imply permission to change the system.

## 1. Define completion before implementation

For substantial tasks, record a concise acceptance contract in the plan or working notes:

- What the user will be able to accomplish.
- The complete workflows that must work.
- Observable criteria for the requested quality level and how they will be verified.
- Explicit exclusions and material assumptions.

Derive the contract from the original request and project context, not from what is easiest to build. Ask about missing choices that materially change the result; infer ordinary usability needs instead of requiring the user to enumerate them. Avoid lengthy specifications or approval ceremonies for routine work.

For a broad but sparsely specified task, default to a complete, polished, usable outcome at the requested product level—not an MVP, prototype, demo or technical foundation. Infer the necessary workflows, integration and quality requirements from the goal, existing product and established conventions. Sparse wording is not permission to reduce the target. An MVP or otherwise reduced deliverable requires the user's explicit request or agreement. Stage implementation internally when useful, but do not hand off the first stage as the completed task. Completeness means fulfilling the requested outcome and its necessary dependencies, not adding speculative features or unlimited parity with a reference product; ask about consequential unresolved product choices without making the user specify ordinary completeness.

Distinguish three kinds of work:

- **Explicit outcomes:** what the user requested.
- **Necessary completion work:** integrations, existing behaviors and product conventions needed for those outcomes to work. Discover and include these without asking the user to write technical requirements.
- **Optional expansion:** independent new capabilities or product-policy changes. Do not add these without authorization.

Use the dependency test: would omitting this work leave the requested workflow unusable, inconsistent with the existing product, misleading, or regress an affected existing behavior? If yes, it belongs to completion, even if it is in another file or layer. This does not authorize unrelated cleanup, deployment, production data changes or inventing business rules. Record ordinary implementation assumptions; ask only for consequential choices the existing product and request do not settle. Self-written acceptance criteria and exclusions must not shrink the user's goal.

For substantial tasks, before coding inspect the nearest working feature and trace the affected path from real entrypoint to stored result and back. Keep a short impact map in working notes: affected producers/consumers, shared contracts, existing behavior to preserve, and how each consequential connection will be verified. Use actual callers, schemas and project conventions, not only filenames suggested by the ticket. Scale this to risk; it is not a new design document or a whole-repository audit.

A benchmark such as “a Webflow-level editor” is not permission to clone every feature, but must inform the relevant interactions and quality criteria. Do not silently substitute a form-based HTML editor. A material reduction of the requested target requires the user's agreement, not merely an exclusion written by the agent.

## 2. Review both underdelivery and overengineering

Give the devil's advocate the original request, acceptance contract, constraints, and direct access to implementation or verification evidence—not only the builder's summary.

The reviewer checks both:

- **Underdelivery:** missing core interactions, incomplete workflows, awkward workarounds, superficial polish, mock-only behavior, and unverified persistence or recovery.
- **Overengineering:** unnecessary abstractions, speculative extensibility, unrelated refactors, and complexity without a current requirement.

A simpler alternative is acceptable only if it preserves the agreed workflows and quality level. Compare alternatives for consequential choices; do not invent an alternative plan for every small change. Reconcile material findings before acceptance. Reject unsupported findings with evidence instead of adding work automatically.

The primary agent performs its own integration check before handing off to the reviewer. Give the reviewer the impact map and actual verification evidence as well as the original request. The review must challenge omissions in the plan itself, not merely check that the implementation follows it. An external Kanban review round is not a substitute for the implementer's first completeness pass.

For each confirmed finding, identify the missed invariant and inspect affected sibling paths before fixing it. A new field missing from restore is a reason to inspect its other lifecycle consumers, not only patch that assignment. After the fix, verify the reported reproduction and an adjacent case that could expose the same omission. Address relevant, low-risk consistency defects in the current task; severity "low" alone is not a reason to return them to the user. Do not turn a cosmetic observation into an unrelated redesign.

## 3. Build complete workflows

Organize implementation around usable end-to-end slices, not just files, layers, or disconnected components. For an editor whose scope includes these interactions, a slice could be:

> Add an element → drag it into position → change its settings → undo a change → save → reopen and verify the saved result.

A panel, an API, and a screenshot do not alone complete that workflow. Use milestones to manage large tasks, but retain the original acceptance contract across milestones. A first slice is not the whole deliverable unless the user requested only that slice.

For each new core helper or service, identify and exercise its real application caller. A module called only by its own tests is not an integrated feature. Follow values through validation, serialization, persistence, reads and rendering; matching types or a successful HTTP response alone do not establish matching behavior.

When data or a shared contract changes, inspect the relevant lifecycle: new and existing records, omission/null/empty/clear semantics, clone or revision restore, import/export and post-save refresh, preview versus published rendering, and derived consumers such as caches, search indexes or resource-reference tracking. Include the paths the project actually has and the change affects; explain a non-obvious exclusion instead of assuming a non-mentioned channel does not matter. Preserve old data and accepted workflows unless their change is part of the request.

Check the feature's normal failure/recovery path, not just its happy path: for example, expired or changed data at submit, a failed load, and malformed existing content where relevant. New failures must reach the product's existing error experience, preserve recoverable user work, and avoid breaking unrelated items that can still operate safely. Preserve atomic rollback where operations must succeed together. Do not leave a fallback control that can never produce a valid request.

Use existing UI components, localization/formatting helpers, permissions and interaction conventions where applicable. Check their real behavior before claiming a reuse blocker. If a shared component lacks something necessary, compare a small compatible extension with a justified local exception; do not silently copy it merely because copying is faster. Update affected existing documentation, generated guides and tool schemas together, and verify that the delivered artifact—not just its source—contains the change.

## 4. Require user-facing evidence

Passing tests is a technical check, not sufficient proof of product acceptance.

- Verify agreed workflows through their real entrypoints and integrations, at a depth proportional to risk.
- For interactive UI work, exercise relevant workflows in a real browser. Check persistence after reopening, error recovery, and important edge cases where applicable. A screenshot alone cannot verify an interaction.
- Use the available `kanban-ui-screenshots` skill for browser operation and captures; this skill sets acceptance criteria, not a replacement browser driver.
- Mocks support isolated tests but cannot establish that a core workflow works end to end. State which integrations were real and which were simulated.
- If required tools or environments are unavailable, complete safe verification that remains possible and mark affected criteria unverified. Do not silently substitute mocks or declare acceptance.

Choose evidence for the integration risk, not the easiest test to write. Include a representative pre-existing record or configuration when compatibility matters, and test a changed value through another affected entrypoint when channels share a contract. For UI integration, a fixture using the real button is still a fixture; it does not prove the authenticated screen, its data flow or persistence. State this distinction without using it as an excuse to stop when a safe real-path check is available.

When local verification fails, investigate whether the change caused it and repair ordinary in-scope setup problems when safe. Do not merely label a failure "pre-existing" without baseline or other concrete evidence. Do not replace dependency versions, disable tests or weaken checks just to obtain a green result. If an external dependency or permission really prevents verification, record the attempted checks and the specific unverified outcome rather than implying the feature passed.

Keep evidence concise and tied to acceptance criteria; large test counts do not substitute for proof of the requested behavior.

## 5. Justify architectural complexity

Reuse existing project structures and conventions. Add an abstraction layer, generic framework, dependency, or broad reorganization only when a concrete requirement of this task justifies it. Explain consequential additions briefly in terms of the requirement they serve.

Do not design for speculative future needs. Equally, do not remove necessary functionality just to keep code small. Aim for the least complex maintainable implementation of the complete agreed outcome, not the fewest lines or fastest first demo.

## 6. Finish against the contract

Before handing off, compare the integrated result with the user's goal, the necessary completion work discovered in the impact map, and every acceptance criterion. The primary agent verifies integration; successful subagent reports are not a substitute. Ask: what ordinary next action would still make the user return and ask us to finish this same feature? Close those in-scope gaps now.

Do not call the task complete while a core workflow is missing, works only with mocks, or has been deferred as “the next step.” Continue safe, authorized work when it can close the gap. Do not stop merely because the easy portion is done or another agent has finished.

Localize blockers. If a business choice blocks one decision, ask it while continuing useful independent work; do not use it to defer unrelated required integrations. Preserve the unresolved choice without guessing it or building speculative machinery for every alternative. Stop when all remaining meaningful work depends on that answer, additional permission or an unavailable external dependency, and report the precise dependency. Do not repeat impossible checks indefinitely or bypass permission boundaries. Honor explicit user instructions to pause, stop, or reduce scope.

In the final report, distinguish **complete**, **unverified**, and **missing/blocked** as applicable. Include relevant evidence and material limitations. Empty sections and long checklists are unnecessary, but test results must never conceal missing functionality. A partial handoff is explicitly partial; it does not rewrite the original goal.

Documenting a missing core capability or a newly introduced regression does not make it an accepted limitation. Neither a commit, a test count nor an automation-generated "implementation complete" heading establishes completion. Do not claim that documentation or tooling supports behavior which the connected application does not yet implement.
