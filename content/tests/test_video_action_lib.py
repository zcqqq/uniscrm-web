import sys
import os

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from video_action_lib import compute_keep_segments, needs_rotation, is_too_short, sample_timestamps, face_ratio


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
