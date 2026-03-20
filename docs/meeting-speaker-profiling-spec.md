# Meeting Speaker Profiling MVP Spec

## Goal
Upgrade meeting mode from simple source labels into more useful speaker-aware meeting blocks, while staying honest about what dual-source local capture can and cannot infer.

## Product Positioning
- This is not full diarization for arbitrary mixed conference audio.
- This MVP focuses on:
  - clearer meeting turn blocks
  - stable source-aware speaker display
  - microphone-side speaker verification groundwork
- This MVP explicitly does not promise:
  - accurate per-person labeling for mixed remote conference audio
  - persistent remote speaker identity across meetings
  - zero-error identity matching

## Current State
- `meeting_caption` already includes:
  - `speakerId`
  - `speakerLabel`
  - `source`
- Current sidecar speaker handling maps directly from `source`:
  - `microphone`
  - `system`
- Renderer already shows speaker labels and transcript blocks.
- User settings already support:
  - custom microphone label
  - custom system label

## Problem
Current meeting mode looks too similar to subtitle mode because speaker identity is only source-based. The user wants transcript display that feels more like a conversation record, where speaking turns are visually grouped and where the local speaker can be identified as a named person such as `Dave`.

## Constraints
### Architecture constraints
- Audio is captured in dual-source form:
  - microphone stream
  - system-audio stream
- Remote system audio may be:
  - a single remote speaker
  - multiple remote participants mixed together by the conferencing app

### Technical constraints
- Mixed system audio is not a reliable basis for first-pass per-person diarization.
- Any speaker identity feature must preserve a stable fallback path to source-based labels.
- Event-schema changes must remain backward-compatible enough for current renderer flow.

## MVP Scope
### In scope
- Turn-oriented meeting transcript display
- Explicit speaker block metadata in meeting events/state
- Microphone-side speaker enrollment and verification foundation
- User-visible naming of the local verified speaker
- Conservative remote handling:
  - continue showing `遠端` or configured remote label
  - optionally prepare metadata hooks for future clustering, but do not claim more

### Out of scope
- Full remote multi-speaker diarization on mixed system audio
- Automatic remote `Speaker A / Speaker B` assignment for arbitrary mixed calls
- Cross-meeting persistence of remote voice identities
- Re-clustering the whole transcript history in this first pass

## User Experience
### Meeting transcript
- Transcript should render as speaker blocks rather than a subtitle-like stream.
- Local microphone speech should display under the configured local speaker name.
- Remote system audio should display under the configured remote label.

### Local speaker verification
- User can optionally enroll the local speaker from microphone audio.
- When microphone speech matches the enrolled profile with sufficient confidence:
  - transcript uses the user-provided speaker label, such as `Dave`
- When confidence is too low:
  - transcript falls back to a neutral local label such as configured microphone label
- No first-pass UI is required for complex remote speaker naming workflows.

## Data Model Changes
### Meeting event extensions
Extend `meeting_caption` with speaker-oriented metadata that is useful now and safe for future growth.

Proposed fields:
- `speakerKind`
  - `source-default`
  - `verified-local`
  - `unverified-local`
  - `remote-default`
- `speakerProfileId?`
  - stable ID for enrolled local speaker profile
- `speakerMatchConfidence?`
  - numeric confidence for local verification
- `turnId?`
  - stable ID for a rendered speaker turn block

### Why these fields
- `speakerKind` gives renderer and persistence code a semantic layer beyond raw `source`
- `speakerProfileId` avoids hard-coding display names into identity logic
- `speakerMatchConfidence` gives future debugging and UI affordances without forcing them now
- `turnId` enables renderer grouping/upsert behavior at the speaker-turn level

## Sidecar Changes
### Phase A: turn-oriented meeting chunks
- Preserve current chunk emission but enrich each meeting chunk with turn metadata.
- Group consecutive same-source chunks into speaker turns when close in time.
- Emit a stable `turnId` per grouped turn.

### Phase B: microphone enrollment foundation
- Add a sidecar path to capture microphone reference audio for local speaker enrollment.
- Extract and persist a local speaker embedding/profile.
- On later microphone meeting chunks:
  - compute embedding
  - compare against enrolled local profile
  - classify as `verified-local` only above threshold
  - otherwise keep source-default local handling

### Fallback behavior
- If no enrollment exists, current behavior remains source-based.
- If verification fails or model dependencies are unavailable, current behavior remains source-based.

## Renderer Changes
- Update meeting state to store new speaker metadata and `turnId`.
- Update meeting transcript rendering to emphasize speaker turns.
- Resolve display label in this order:
  - enrolled/verified local custom label
  - configured local or remote source label
  - existing event `speakerLabel`

## Persistence Changes
- Meeting transcript markdown should continue to store speaker labels as plain text.
- Local speaker profile persistence should be separate from transcript persistence.
- Suggested storage:
  - app settings or a dedicated profile file under app data

## Validation Plan
- Type-check shared types and renderer flow
- Unit-test meeting reducer turn grouping/upsert behavior
- Unit-test sidecar helper logic for speaker-kind resolution and fallback behavior
- Run offline speaker benchmark manifests and track:
  - `falseAcceptRate`
  - `falseRejectRate`
  - confidence distribution across positive vs negative cases
- Manual smoke test:
  - no enrollment path still works
  - enrolled local speaker maps to named label in meeting transcript
  - remote audio still falls back to configured remote label

## Risks
- Microphone-side verification may still drift if enrollment audio is poor.
- Turn grouping thresholds may need tuning to avoid over-merging or over-splitting.
- Remote system audio remains fundamentally constrained by mixed conferencing output.

## Future Work
- Offline benchmark gate before embedding backend migration
- Optional remote experimental clustering for explicit 1v1 meetings
- Reassignment tools for mistaken speaker labels
- Recompute transcript labeling from saved speaker embeddings
