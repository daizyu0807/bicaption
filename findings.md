# Findings & Decisions

## Requirements
- User wants meeting subtitles to move beyond plain dual-source labeling.
- Desired UX: meeting transcript should show speaker-aware blocks that can later map to a person name such as `Dave`.
- User explicitly asked to use Claude cross-thinking to inspect the direction before implementing.
- Work should start with a concrete spec, then proceed into implementation.

## Research Pack
<!-- research-pack:start -->
goal: Define a realistic speaker-aware meeting-mode MVP for the existing Electron + Python architecture.
current_state:
  - `meeting_caption` already carries `speakerId`, `speakerLabel`, and `source`.
  - Current speaker labeling is source-based (`microphone` / `system`), not voiceprint-based.
  - UI already renders speaker labels and allows custom microphone/system labels.
  - Meeting reducer already upserts entries by segment ID and stores speaker metadata.
constraints:
  - Existing meeting mode uses dual-source capture, with remote audio possibly mixed into one stream.
  - User wants a spec-first approach before implementation.
  - Need to preserve a stable fallback path if richer speaker attribution is uncertain.
unknowns:
  - What is the thinnest microphone-enrollment feature that materially improves meeting UX?
  - How much of the final desired speaker workflow can be implemented safely in the first MVP?
sources:
  - src/meeting-state.ts
  - src/App.tsx
  - python/sidecar.py
  - electron/types.ts
  - Claude cross-review result captured on 2026-03-20 via `claude -p --output-format json`
rejected_paths:
  - Full multi-speaker diarization on mixed system audio as the first implementation target
<!-- research-pack:end -->

## Research Findings
- Current meeting speaker handling is only a presentation layer over `source`, not true speaker identity.
- The codebase already has the right seam for incremental improvement: `meeting_caption` event schema and meeting reducer.
- Claude review confirmed the structural bottleneck is remote mixed system audio, not the absence of a waveform UI.
- The highest-value reliable step is to strengthen turn-based meeting blocks and microphone-side speaker verification before attempting remote multi-speaker clustering.

## Technical Decisions
| Decision | Rationale |
|----------|-----------|
| Use spec wording that distinguishes `speaker verification` from `speaker diarization` | Prevents overpromising and aligns UX with what the architecture can support |
| Keep `source` as a first-class field even after speaker improvements | It remains the most reliable classification axis in dual-source meeting capture |
| Plan for future metadata such as cluster/profile IDs even if MVP only uses part of it | Avoids painting the event schema into a corner |

## Issues Encountered
| Issue | Resolution |
|-------|------------|
| `claude -p` did not show immediate stdout during cross-review | Verified auth, read CLI help, then switched to `--output-format json` and longer wait windows |

## Resources
- `/Users/davedai/Project/tools/realtime-bilingual-subtitles/src/meeting-state.ts`
- `/Users/davedai/Project/tools/realtime-bilingual-subtitles/src/App.tsx`
- `/Users/davedai/Project/tools/realtime-bilingual-subtitles/python/sidecar.py`
- `/Users/davedai/Project/tools/realtime-bilingual-subtitles/electron/types.ts`

## Visual/Browser Findings
- No browser research used in this phase.
