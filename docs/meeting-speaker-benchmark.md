# Meeting Speaker Benchmark

## Goal
Track local speaker verification quality with repeatable offline runs instead of relying on ad-hoc logs.

## Manifest Format
Create a JSON manifest next to your WAV files:

```json
{
  "threshold": 0.82,
  "reference": {
    "audioPath": "reference.wav"
  },
  "cases": [
    {
      "id": "same-speaker-1",
      "audioPath": "same-speaker-1.wav",
      "expectedMatch": true,
      "notes": "quiet room"
    },
    {
      "id": "different-speaker-1",
      "audioPath": "different-speaker-1.wav",
      "expectedMatch": false,
      "notes": "similar mic, different speaker"
    }
  ]
}
```

## Audio Requirements
- WAV
- mono
- 16-bit PCM
- 16kHz

## Run

```bash
python3 python/speaker-benchmark.py \
  --manifest /abs/path/to/manifest.json
```

Optional:

```bash
python3 python/speaker-benchmark.py \
  --manifest /abs/path/to/manifest.json \
  --threshold 0.84 \
  --output-dir /abs/path/to/output
```

## Outputs
Each run writes:
- `*-speaker-benchmark.json`
- `*-speaker-benchmark.md`

Default output directory:
- manifest folder `/benchmark-results`

## What To Track
- `falseAcceptRate`
- `falseRejectRate`
- `avgPositiveConfidence`
- `avgNegativeConfidence`

## Current Upgrade Gate
Use this benchmark before considering a backend migration such as `resemblyzer`.

Suggested trigger:
- `falseAcceptRate > 0.10`
- or `falseRejectRate > 0.20`

If the current fingerprint path stays under those bounds across real recordings, keep the simpler implementation.
