# Profile Maigret Status State Machine

```mermaid
stateDiagram-v2
    [*] --> pending : profile created (default)

    pending --> running : maigret-retry triggered / queue message received
    running --> done : search completed, socials found
    running --> not_found : search completed, no socials matched
    running --> error : container crash / timeout / maigret exception

    error --> running : maigret-retry (re-scan)
    not_found --> running : maigret-retry (re-scan)

    done --> done : re-scan finds new socials (merge)
```

## Status Definitions

| Status | Meaning | Terminal? |
|--------|---------|-----------|
| `pending` | Profile created, maigret scan not yet started | No |
| `running` | Maigret container is actively scanning | No |
| `done` | Scan completed successfully, social profiles found | Yes (can re-scan) |
| `not_found` | Scan completed successfully, no social profiles found for this username | Yes (can re-scan) |
| `error` | Scan process failed (container crash, timeout, Python exception) | No (auto-retry) |
