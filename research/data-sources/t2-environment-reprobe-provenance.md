# t2-environment-reprobe provenance

Access date (UTC): 2026-05-31T09:52:19.773305+00:00

## Sources and methods
- Local HTTP probe: `http://127.0.0.1:5173/` using curl with two retries, 5 second max-time per attempt. This is a local operator-managed Diedrico endpoint; no service control was attempted.
- Local executable probes: `command -v` and `-version` for `ffmpeg`, `ffprobe`, `piper`, and `espeak-ng`; no installation was attempted.
- Context read: `/work/diedrico-lessons/SPEC.md` and previous task report were parsed/read for context; contents were not copied into this note.

## License/terms
- Not applicable to local environment probes. Diedrico app/source remains read-only under project scope rules.

## Attempt notes
- Initial shell wrapper failed before probes because `python` was unavailable; the successful rerun used `python3` and preserved the failure logs.

## Artifact checksums
- `/work/saivage-v3/.saivage/stages/lesson-cycle-002-bootstrap-recovery-review/data/t2-environment-reprobe/context-read.log`: 818 bytes, sha256 `8e5084ae1578157fa59814476b4259ce67d4ec2e961e78549709f4e9af42c94d`
- `/work/saivage-v3/.saivage/stages/lesson-cycle-002-bootstrap-recovery-review/data/t2-environment-reprobe/context-read.stderr`: 0 bytes, sha256 `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`
- `/work/saivage-v3/.saivage/stages/lesson-cycle-002-bootstrap-recovery-review/data/t2-environment-reprobe/diedrico-root.probe.log`: 241 bytes, sha256 `81702814a69394bc1de95cb304bf19b3bcdad62bd66ae4ee4b89981da424e244`
- `/work/saivage-v3/.saivage/stages/lesson-cycle-002-bootstrap-recovery-review/data/t2-environment-reprobe/diedrico-root.response`: 62 bytes, sha256 `07d8ef5b5809296c5ea7fc3e6f1c633e56c4a718824403020c4c2f3fa580aaff`
- `/work/saivage-v3/.saivage/stages/lesson-cycle-002-bootstrap-recovery-review/data/t2-environment-reprobe/diedrico-root.stderr`: 91 bytes, sha256 `0f52c3623e1434663e04167570c4553f5675f817bcda3b0c0612676ac77d6e5a`
- `/work/saivage-v3/.saivage/stages/lesson-cycle-002-bootstrap-recovery-review/data/t2-environment-reprobe/rerun.stderr`: 0 bytes, sha256 `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`
- `/work/saivage-v3/.saivage/stages/lesson-cycle-002-bootstrap-recovery-review/data/t2-environment-reprobe/rerun.stdout`: 0 bytes, sha256 `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`
- `/work/saivage-v3/.saivage/stages/lesson-cycle-002-bootstrap-recovery-review/data/t2-environment-reprobe/run.stderr`: 0 bytes, sha256 `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`
- `/work/saivage-v3/.saivage/stages/lesson-cycle-002-bootstrap-recovery-review/data/t2-environment-reprobe/run.stdout`: 0 bytes, sha256 `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`
- `/work/saivage-v3/.saivage/stages/lesson-cycle-002-bootstrap-recovery-review/data/t2-environment-reprobe/tool-availability.log`: 267 bytes, sha256 `f9869f202ef91f05ef1d7c10bdfaf827289467cc1a5f86c819d622c263d22a1a`
