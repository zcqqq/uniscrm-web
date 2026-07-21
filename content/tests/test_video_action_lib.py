import sys
import os

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from video_action_lib import compute_keep_segments, needs_rotation, is_too_short


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
