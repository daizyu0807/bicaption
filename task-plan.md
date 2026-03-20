# Task Plan: Meeting Speaker Profiling MVP

## Goal
Design and implement a meeting-mode MVP that upgrades source-based labels into turn-based speaker blocks and microphone-side speaker verification, without overpromising multi-speaker system-audio diarization.

## Task Classification
- Mode: strict
- Reason: This is brownfield, multi-file, event-schema-affecting work across Electron, renderer, and Python sidecar.
- Expected artifacts:
  - research pack
  - plan pack
  - validation evidence
  - implementation spec

## Plan Pack
<!-- plan-pack:start -->
scope: Add a spec and MVP implementation for meeting speaker turns plus microphone-side speaker enrollment/verification foundations, while keeping system-audio handling conservative.
non_goals:
  - Full multi-speaker diarization on mixed system audio
  - Cross-meeting persistent remote speaker identity
  - Perfect real-time per-person attribution for remote conference mixes
files_to_change:
  - docs/meeting-speaker-profiling-spec.md
  - task-plan.md
  - findings.md
  - progress.md
  - python/sidecar.py
  - electron/types.ts
  - electron/main.ts
  - electron/preload.cjs
  - src/types.d.ts
  - src/meeting-state.ts
  - src/App.tsx
  - tests/meeting-state.test.ts
  - python/tests/test_sidecar.py
change_strategy:
  - Write a concrete MVP spec first using current codebase constraints plus Claude cross-review guidance
  - Extend meeting event/state model with turn-oriented speaker metadata instead of jumping to full diarization
  - Implement source-safe MVP first: turn segmentation, explicit speaker blocks, and microphone enrollment scaffolding
  - Validate with existing test suites and targeted new tests
validation_plan:
  - npm run type-check
  - npm test
  - python3 -m unittest python.tests.test_sidecar
rollback_or_fallback: Keep source-based labels as the stable fallback path and gate new speaker features behind conservative matching logic.
open_risks:
  - System-audio mixed remote speech may not support stable per-person attribution
  - Event/schema expansion can ripple through renderer and persistence code
  - Enrollment UX may need a thinner first pass than the full desired workflow
<!-- plan-pack:end -->

## Current Phase
Phase 3

## Phases
### Phase 1: Requirements & Discovery
- [x] Understand user intent
- [x] Identify constraints and requirements
- [x] Document findings in findings.md
- **Status:** complete

### Phase 2: Spec & Architecture
- [x] Define MVP scope and non-goals
- [x] Write spec with event/state updates
- [x] Record decisions with rationale
- **Status:** complete

### Phase 3: Implementation
- [ ] Implement sidecar and event-schema changes
- [ ] Implement renderer/state changes
- [ ] Add or update tests
- **Status:** in_progress

### Phase 4: Testing & Verification
- [ ] Run impacted test suites
- [ ] Fix issues found in validation
- [ ] Record evidence in progress.md
- **Status:** pending

### Phase 5: Delivery
- [ ] Review spec and implementation alignment
- [ ] Create local checkpoint commit(s)
- [ ] Deliver outcome and remaining risks
- **Status:** pending

## Key Questions
1. What is the narrowest meeting-speaker feature that improves UX without pretending mixed remote diarization is solved?
2. Which event fields are required now so future clustering/enrollment work can evolve without breaking the renderer?
3. How should microphone-side verification be introduced without blocking current meeting transcript flow?

## Decisions Made
| Decision | Rationale |
|----------|-----------|
| Treat microphone verification as higher-value than remote mixed-audio diarization | This matches both current dual-source architecture and Claude cross-review guidance |
| Write spec before code changes | The user explicitly asked for spec-first execution on a protocol-changing feature |
| First MVP will focus on turn-based meeting blocks plus local speaker verification foundations | This is the narrowest change that improves UX without false claims about mixed remote audio |

## Errors Encountered
| Error | Attempt | Resolution |
|-------|---------|------------|
| Claude CLI `-p` appeared to hang with no immediate stdout | 1 | Switched to `--output-format json` and waited for the full result instead of treating the first short poll as failure |

## Notes
- Keep source-based labels as a fallback path throughout implementation.
- Do not turn speculative clustering into user-facing certainty.
