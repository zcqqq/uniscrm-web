import sys
import os

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from video_action_lib import compute_keep_segments, needs_rotation, is_too_short, sample_timestamps, face_ratio, aspect_ratio


def test_compute_keep_segments_no_faces_keeps_whole_video():
    assert compute_keep_segments([], 10.0) == [(0.0, 10.0)]


def test_compute_keep_segments_single_face_segment_padded_and_cut_out():
    result = compute_keep_segments([5.0], 10.0)
    assert result == [(0.0, 4.8), (6.2, 10.0)]


def test_compute_keep_segments_merges_adjacent_face_samples():
    result = compute_keep_segments([3.0, 4.0, 5.0], 10.0)
    assert result == [(0.0, 2.8), (6.2, 10.0)]


def test_compute_keep_segments_merges_nearby_but_non_adjacent_faces_within_merge_gap():
    result = compute_keep_segments([0.0, 2.0], 10.0, sample_interval=1.0, merge_gap=1.5)
    assert result == [(3.2, 10.0)]


def test_compute_keep_segments_does_not_merge_faces_beyond_merge_gap():
    result = compute_keep_segments([0.0, 5.0], 10.0, sample_interval=1.0, merge_gap=1.0)
    assert result == [(1.2, 4.8), (6.2, 10.0)]


def test_compute_keep_segments_padding_clamped_at_video_start_and_end():
    result = compute_keep_segments([0.0, 9.0], 10.0, sample_interval=1.0, merge_gap=1.0)
    assert result == [(1.2, 8.8)]


def test_needs_rotation_true_for_landscape():
    assert needs_rotation(1920, 1080) is True


def test_needs_rotation_false_for_portrait():
    assert needs_rotation(1080, 1920) is False


def test_needs_rotation_false_for_square():
    assert needs_rotation(1000, 1000) is False


def test_is_too_short_below_threshold():
    assert is_too_short(1.5) is True


def test_is_too_short_at_or_above_threshold():
    assert is_too_short(2.0) is False
    assert is_too_short(5.0) is False


def test_sample_timestamps_spreads_evenly_and_avoids_the_very_ends():
    # 20 samples across 100s: midpoints of 20 equal 5s slices — never 0.0 (often black//fade-in)
    # and never the exact duration (past the last frame).
    result = sample_timestamps(100.0, 20)
    assert len(result) == 20
    assert result[0] == 2.5
    assert result[-1] == 97.5


def test_sample_timestamps_short_video_still_returns_distinct_in_range_points():
    result = sample_timestamps(2.0, 20)
    assert len(result) == 20
    assert all(0.0 < t < 2.0 for t in result)
    assert len(set(result)) == 20


def test_sample_timestamps_rejects_non_positive_duration():
    assert sample_timestamps(0.0, 20) == []
    assert sample_timestamps(-5.0, 20) == []


def test_face_ratio_basic():
    assert face_ratio(7, 20) == 0.35
    assert face_ratio(0, 20) == 0.0
    assert face_ratio(20, 20) == 1.0


def test_face_ratio_is_none_when_nothing_was_decodable():
    # Distinct from 0.0: "no frame could be read" must fail the node, not report "no faces".
    assert face_ratio(0, 0) is None


def test_aspect_ratio_basic():
    assert aspect_ratio(1920, 1080) == 1920 / 1080
    assert aspect_ratio(1080, 1920) == 1080 / 1920
    assert aspect_ratio(1000, 1000) == 1.0


def test_aspect_ratio_none_when_height_is_zero():
    # Distinct from raising ZeroDivisionError: unmeasurable dimensions must fail the node, not crash it.
    assert aspect_ratio(1920, 0) is None


# --- ASS subtitle building (add-subtitle karaoke + title overlay) ---

from video_action_lib import ass_timestamp, karaoke_line, build_ass
import re


def test_ass_timestamp_formats_centiseconds():
    assert ass_timestamp(0) == "0:00:00.00"
    assert ass_timestamp(4240) == "0:00:04.24"
    assert ass_timestamp(3723456) == "1:02:03.46"


def test_karaoke_line_cjk_gets_one_tag_per_character_summing_to_duration():
    line = karaoke_line("你好吗", 3000)
    tags = [int(m) for m in re.findall(r"\\kf(\d+)", line)]
    assert len(tags) == 3
    assert sum(tags) == 300  # centiseconds
    assert line.replace("{", "").replace("}", "")  # tags present, text preserved
    assert "你好吗" == re.sub(r"\{[^}]*\}", "", line)


def test_karaoke_line_spaced_text_gets_one_tag_per_word():
    line = karaoke_line("hello brave world", 2000)
    tags = [int(m) for m in re.findall(r"\\kf(\d+)", line)]
    assert len(tags) == 3
    assert sum(tags) == 200
    assert re.sub(r"\{[^}]*\}", "", line) == "hello brave world"


def test_karaoke_line_longer_words_get_longer_durations():
    line = karaoke_line("a bbbb", 1000)
    tags = [int(m) for m in re.findall(r"\\kf(\d+)", line)]
    assert tags[0] < tags[1]


def test_build_ass_has_resolution_styles_and_karaoke_events():
    cues = [
        {"start_ms": 0, "end_ms": 2000, "text": "你好。"},
        {"start_ms": 2000, "end_ms": 4000, "text": "这是一个测试。"},
    ]
    ass = build_ass(cues, "一个标题", 1080, 1920, 660, 1268, 84000)
    assert "PlayResX: 1080" in ass
    assert "PlayResY: 1920" in ass
    assert "Style: Sub," in ass
    assert "Style: Title," in ass
    # Title runs the whole video, on the Title style.
    assert "Dialogue: 0,0:00:00.00,0:01:24.00,Title,,0,0,0,,一个标题" in ass
    # Both cues present with karaoke tags.
    assert ass.count("\\kf") >= 2
    assert "0:00:02.00,0:00:04.00,Sub" in ass


def test_build_ass_without_title_has_no_title_event():
    cues = [{"start_ms": 0, "end_ms": 1000, "text": "hi"}]
    ass = build_ass(cues, "", 1080, 1920, None, None, 1000)
    assert "Title,,0,0,0" not in ass


def test_build_ass_sanitizes_braces_in_text():
    cues = [{"start_ms": 0, "end_ms": 1000, "text": "a{b}c"}]
    ass = build_ass(cues, "t{i}tle", 1080, 1920, None, None, 1000)
    # Braces would open/close ASS override blocks mid-text; they must not survive as-is.
    assert "{b}" not in ass
    assert "{i}" not in ass


def test_build_ass_shrinks_a_long_title_to_fit_the_top_bar():
    # A realistic long YouTube title at the base font would wrap past a 656px top bar; the
    # style's font must shrink and the whole estimated block must stay inside the bar.
    long_title = "Firecrawl Made PDF Parsing 100x Faster For AI Agents And Everyone Else"
    ass = build_ass([{"start_ms": 0, "end_ms": 1000, "text": "hi"}], long_title, 1080, 1920, 656, 1476, 1000)
    style = next(l for l in ass.splitlines() if l.startswith("Style: Title,"))
    font = int(style.split(",")[2])
    margin_v = int(style.split(",")[-2])
    base_font = round(round(1920 / 18) * 1.2)
    assert font < base_font
    # estimated block must fit between margin and the picture top
    import math as _math
    from video_action_lib import _estimate_text_width
    lines = _math.ceil(_estimate_text_width(long_title, font) / (1080 - 60))
    assert margin_v + lines * font * 1.3 <= 656


def test_build_ass_keeps_base_font_for_a_short_title():
    ass = build_ass([{"start_ms": 0, "end_ms": 1000, "text": "hi"}], "短标题", 1080, 1920, 656, 1476, 1000)
    style = next(l for l in ass.splitlines() if l.startswith("Style: Title,"))
    font = int(style.split(",")[2])
    assert font == round(round(1920 / 18) * 1.2)
