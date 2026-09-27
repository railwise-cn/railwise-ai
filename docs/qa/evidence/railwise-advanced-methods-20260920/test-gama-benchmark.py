#!/usr/bin/env python3
"""Read-only negative checks for the archived Gama evidence comparator."""

import copy
import importlib.util
import io
import json
import unittest
import xml.etree.ElementTree as ET
from pathlib import Path

ROOT = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location("gama_benchmark", ROOT / "run-gama-benchmark.py")
BENCHMARK = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(BENCHMARK)


class EvidenceCompletenessTests(unittest.TestCase):
    def setUp(self):
        self.data = json.loads((ROOT / "gama-outputs/free-leveling-001-gso.json").read_text())
        self.xml = ET.parse(ROOT / "gama-outputs/free-leveling-001-gso.xml").getroot()
        for element in self.xml.iter():
            element.tag = element.tag.split("}")[-1]

    def compare(self):
        return BENCHMARK.compare(self.data, io.StringIO(ET.tostring(self.xml, encoding="unicode")), 0)

    def test_complete_archived_result_passes(self):
        self.compare()

    def test_missing_adjusted_section_is_rejected(self):
        coordinates = self.xml.find("coordinates")
        coordinates.remove(coordinates.find("adjusted"))
        with self.assertRaisesRegex(AssertionError, "three adjusted points"):
            self.compare()

    def test_missing_observations_section_is_rejected(self):
        self.xml.remove(self.xml.find("observations"))
        with self.assertRaisesRegex(AssertionError, "three height differences"):
            self.compare()

    def test_missing_or_duplicate_adjusted_point_is_rejected(self):
        points = self.xml.find("coordinates/adjusted")
        points.remove(points[-1])
        with self.assertRaisesRegex(AssertionError, "three adjusted points"):
            self.compare()
        points.append(copy.deepcopy(points[0]))
        with self.assertRaisesRegex(AssertionError, "point IDs"):
            self.compare()

    def test_missing_or_duplicate_observation_is_rejected(self):
        observations = self.xml.find("observations")
        observations.remove(observations[-1])
        with self.assertRaisesRegex(AssertionError, "three height differences"):
            self.compare()
        observations.append(copy.deepcopy(observations[0]))
        with self.assertRaisesRegex(AssertionError, "observation IDs"):
            self.compare()

    def test_wrong_observation_direction_is_rejected(self):
        self.xml.find("observations/height-diff/from").text = "C"
        with self.assertRaisesRegex(AssertionError, "observation IDs"):
            self.compare()

    def test_missing_covariance_element_is_rejected(self):
        covariance = self.xml.find("coordinates/cov-mat")
        covariance.remove(covariance.findall("flt")[-1])
        with self.assertRaises(ValueError):
            self.compare()

    def test_nonfinite_coordinate_is_rejected(self):
        self.xml.find("coordinates/adjusted/point/Z").text = "nan"
        with self.assertRaises(AssertionError):
            self.compare()


if __name__ == "__main__":
    unittest.main()
