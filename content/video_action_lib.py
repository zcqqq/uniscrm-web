def compute_keep_segments(face_timestamps, video_duration, sample_interval=1.0, merge_gap=1.0, pad=0.2):
    """Given sampled timestamps (seconds) where a face was detected, returns the list of
    (start, end) segments to KEEP — the complement of all face segments, after merging
    near-adjacent face segments and padding each to avoid abrupt mid-motion cuts."""
    if not face_timestamps:
        return [(0.0, video_duration)]

    raw_segments = sorted((t, t + sample_interval) for t in face_timestamps)

    merged = [raw_segments[0]]
    for start, end in raw_segments[1:]:
        last_start, last_end = merged[-1]
        if start - last_end <= merge_gap:
            merged[-1] = (last_start, max(last_end, end))
        else:
            merged.append((start, end))

    padded = [(max(0.0, s - pad), min(video_duration, e + pad)) for s, e in merged]

    face_segments = [padded[0]]
    for start, end in padded[1:]:
        last_start, last_end = face_segments[-1]
        if start <= last_end:
            face_segments[-1] = (last_start, max(last_end, end))
        else:
            face_segments.append((start, end))

    keep_segments = []
    cursor = 0.0
    for start, end in face_segments:
        if start > cursor:
            keep_segments.append((cursor, start))
        cursor = max(cursor, end)
    if cursor < video_duration:
        keep_segments.append((cursor, video_duration))

    return keep_segments


def needs_rotation(width, height):
    """True only for strictly landscape video — portrait and square are left unchanged."""
    return width > height


def is_too_short(total_kept_duration, min_duration=2.0):
    return total_kept_duration < min_duration
