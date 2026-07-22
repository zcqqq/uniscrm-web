# video_action_jobs.job_status state machine

```mermaid
stateDiagram-v2
    [*] --> downloading
    downloading --> transcribing: add-subtitle
    transcribing --> translating
    translating --> burning_in
    burning_in --> success
    downloading --> rotating: rotate-to-vertical
    rotating --> success
    downloading --> detecting_faces: remove-face
    detecting_faces --> success
    downloading --> sampling_faces: check-face
    sampling_faces --> success
    downloading --> failed
    transcribing --> failed
    translating --> failed
    burning_in --> failed
    rotating --> failed
    detecting_faces --> failed
    sampling_faces --> failed
    success --> [*]
    failed --> [*]
```

For `check-face` (the `videoCondition` node), `success` means "the face ratio was measured" —
not "the condition passed". The `true`/`false` decision is made by `flow`'s resume route.
