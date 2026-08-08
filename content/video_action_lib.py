import math


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


def aspect_ratio(width, height):
    """width / height, or None if height is falsy (unmeasurable dimensions) -- mirrors
    face_ratio's None-for-unmeasurable convention rather than raising ZeroDivisionError."""
    if not height:
        return None
    return width / height


# --- ASS subtitle building (add-subtitle karaoke + title overlay) ---
#
# The worker sends structured cues (millisecond offsets) and a translated title; the ASS file
# is authored here because only the container knows the frame geometry (dimensions + letterbox
# box from cropdetect). PlayRes is set to the real frame size so every margin below is in
# actual pixels — no more translating through ffmpeg's 288-unit SRT-conversion space.

# Font sizing keeps the visual size of the old SRT path: ffmpeg's SRT->ASS conversion used
# Fontsize 16 at PlayResY 288, i.e. height/18.
_SUB_FONT_DIVISOR = 18
# The old force_style clearance was 34/288 of frame height (two wrapped lines + gap).
_SUB_CLEARANCE_RATIO = 34 / 288
_DEFAULT_MARGIN_RATIO = 10 / 288


def ass_timestamp(ms):
    """H:MM:SS.cc — the timestamp format ASS Dialogue lines use."""
    cs = int(round(ms / 10))
    hours, rem = divmod(cs, 360000)
    minutes, rem = divmod(rem, 6000)
    seconds, centis = divmod(rem, 100)
    return f"{hours}:{minutes:02d}:{seconds:02d}.{centis:02d}"


def _sanitize_ass_text(text):
    """Braces open/close override blocks and backslashes start control codes mid-text, so none
    of them may survive from cue/title content into the Dialogue line."""
    return str(text).replace("{", "(").replace("}", ")").replace("\\", "/").replace("\n", " ")


def _char_width(ch, font_size):
    """CJK/full-width glyphs ~1 em, everything else ~0.55 em. Estimation only."""
    return font_size if ord(ch) > 0x2E7F else font_size * 0.55


def wrap_unspaced(text, font_size, usable_width):
    """Explicit \\N breaks for text with no spaces: libass only wraps at spaces, so an
    unspaced CJK line would otherwise run straight off both edges of the frame."""
    out, width = [], 0.0
    for ch in str(text):
        cw = _char_width(ch, font_size)
        if out and width + cw > usable_width:
            out.append("\\N")
            width = 0.0
        out.append(ch)
        width += cw
    return "".join(out)


def karaoke_line(text, duration_ms, font_size=None, usable_width=None):
    """Prefixes each token with a \\kf fill tag so the highlight sweeps left-to-right across
    the cue's real start..end window. Spaced text highlights per word; unspaced text (CJK) per
    character. Word-level speech alignment across languages isn't possible for translated
    subtitles, so durations are allocated proportionally to token length — an even sweep that
    tracks the sentence, not the individual spoken word."""
    text = _sanitize_ass_text(text)
    per_character = " " not in text.strip()
    if per_character:
        tokens = list(text)
    else:
        parts = text.split(" ")
        tokens = [p + (" " if i < len(parts) - 1 else "") for i, p in enumerate(parts)]
        tokens = [t for t in tokens if t]
    if not tokens:
        return text

    total_cs = max(int(round(duration_ms / 10)), len(tokens))
    weights = [max(len(t.strip()), 1) for t in tokens]
    weight_sum = sum(weights)
    durations = [total_cs * w // weight_sum for w in weights]
    durations[-1] += total_cs - sum(durations)

    # Spaced text wraps fine in libass; unspaced (CJK) needs explicit \N breaks between
    # karaoke tokens or the line runs off the frame.
    wrap = per_character and font_size and usable_width
    pieces, width = [], 0.0
    for d, t in zip(durations, tokens):
        if wrap:
            cw = _char_width(t, font_size)
            if pieces and width + cw > usable_width:
                pieces.append("\\N")
                width = 0.0
            width += cw
        pieces.append(f"{{\\kf{d}}}{t}")
    return "".join(pieces)


_STYLE_MARGIN_LR = 30
_TITLE_LINE_SPACING = 1.3


def _estimate_text_width(text, font_size):
    """Rough rendered width: CJK/full-width glyphs ~1 em, everything else ~0.55 em. Only used
    to predict how many lines a title wraps into — precision beyond that isn't needed."""
    return sum(font_size if ord(ch) > 0x2E7F else font_size * 0.55 for ch in str(text))


def _fit_title(title_text, frame_width, content_top, base_font, default_margin):
    """(font_size, margin_v) for the title. Real titles are long enough to wrap, so the font
    shrinks (to a floor of 60% of base) until the estimated wrapped block fits inside the top
    letterbox bar, then the block is centered in the bar. With no detected bar the title just
    hugs the top edge at the default margin."""
    usable = max(frame_width - 2 * _STYLE_MARGIN_LR, 1)
    bar = (content_top - 2 * default_margin) if content_top else 0
    font = base_font
    floor = round(base_font * 0.6)

    def block_height(f):
        wrapped_lines = max(math.ceil(_estimate_text_width(title_text, f) / usable), 1)
        return wrapped_lines * f * _TITLE_LINE_SPACING

    while font > floor and bar > 0 and block_height(font) > bar:
        font = round(font * 0.9)

    block = block_height(font)
    if content_top and content_top > block:
        margin = max(round((content_top - block) / 2), default_margin)
    else:
        margin = default_margin
    return font, margin


def build_ass(cues, title_text, frame_width, frame_height, content_top, content_bottom, duration_ms):
    """Full ASS document: karaoke subtitle events on the Sub style (parked just under the
    letterboxed picture, same placement rule as the old SRT path) plus, when title_text is
    non-empty, one full-length Dialogue on the Title style centered in the top black bar."""
    sub_font = round(frame_height / _SUB_FONT_DIVISOR)
    default_margin = round(frame_height * _DEFAULT_MARGIN_RATIO)

    sub_margin_v = default_margin
    if content_bottom:
        margin = (frame_height - content_bottom) - round(frame_height * _SUB_CLEARANCE_RATIO)
        if margin > 0:
            sub_margin_v = margin

    title_font, title_margin_v = _fit_title(
        _sanitize_ass_text(title_text), frame_width, content_top, round(sub_font * 1.2), default_margin
    )

    outline = max(round(frame_height / 288), 1)

    lines = [
        "[Script Info]",
        "ScriptType: v4.00+",
        f"PlayResX: {frame_width}",
        f"PlayResY: {frame_height}",
        "WrapStyle: 0",
        "",
        "[V4+ Styles]",
        "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, "
        "Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, "
        "Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
        # Sub: karaoke — sung text turns yellow (PrimaryColour), unsung stays white (SecondaryColour).
        f"Style: Sub,Arial,{sub_font},&H0000FFFF,&H00FFFFFF,&H00000000,&H80000000,"
        f"0,0,0,0,100,100,0,0,1,{outline},0,2,30,30,{sub_margin_v},1",
        f"Style: Title,Arial,{title_font},&H00FFFFFF,&H00FFFFFF,&H00000000,&H80000000,"
        f"1,0,0,0,100,100,0,0,1,{outline},0,8,30,30,{title_margin_v},1",
        "",
        "[Events]",
        "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
    ]

    if title_text:
        end = ass_timestamp(duration_ms if duration_ms else max((c["end_ms"] for c in cues), default=0))
        title = _sanitize_ass_text(title_text)
        if " " not in title.strip():
            title = wrap_unspaced(title, title_font, max(frame_width - 2 * _STYLE_MARGIN_LR, 1))
        lines.append(f"Dialogue: 0,{ass_timestamp(0)},{end},Title,,0,0,0,,{title}")

    for cue in cues:
        start = ass_timestamp(cue["start_ms"])
        end = ass_timestamp(cue["end_ms"])
        text = karaoke_line(
            cue["text"], cue["end_ms"] - cue["start_ms"],
            font_size=sub_font, usable_width=max(frame_width - 2 * _STYLE_MARGIN_LR, 1),
        )
        lines.append(f"Dialogue: 0,{start},{end},Sub,,0,0,0,,{text}")

    return "\n".join(lines) + "\n"
