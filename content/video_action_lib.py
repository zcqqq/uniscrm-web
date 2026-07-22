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


def sample_timestamps(duration, count):
    """Evenly spaced sampling points (seconds) for the face-ratio probe.

    Takes the MIDPOINT of each of `count` equal slices rather than the slice edges: t=0 is
    frequently a black frame or fade-in, and t=duration is past the last frame, so both ends
    would bias the ratio downward."""
    if duration <= 0 or count <= 0:
        return []
    slice_width = duration / count
    return [round(slice_width * (i + 0.5), 3) for i in range(count)]


def face_ratio(detected, sampled):
    """Fraction of successfully decoded frames that contained at least one face.

    Returns None (not 0.0) when nothing was decodable — "no frame could be read" is a failure
    and must fail the node, whereas 0.0 is the legitimate answer "no faces in this video"."""
    if sampled <= 0:
        return None
    return detected / sampled
