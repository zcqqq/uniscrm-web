# video_action_jobs.job_status state machine

```mermaid
stateDiagram-v2
    [*] --> downloading
    downloading --> transcribing
    transcribing --> translating
    translating --> burning_in
    burning_in --> success
    downloading --> failed
    transcribing --> failed
    translating --> failed
    burning_in --> failed
    success --> [*]
    failed --> [*]
```
