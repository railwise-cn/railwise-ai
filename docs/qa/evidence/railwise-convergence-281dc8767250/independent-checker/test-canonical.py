import json
import math
import unittest
from verify_records import digest, json_text
from scoring_oracle import digest as old_digest


class CanonicalTests(unittest.TestCase):
    def test_ecmascript_numeric_boundaries_and_negative_zero(self):
        self.assertEqual(json_text([1.3726709029343796e-7, 1e-6, 1e20, 1e21, -0.0, 1.0]),
                         '[1.3726709029343796e-7,0.000001,100000000000000000000,1e+21,0,1]')

    def test_unicode_strings_and_utf16_key_order(self):
        self.assertEqual(json_text({'\ue000': 2, '\U00010000': 1, '名称': '中文\n"'}, sort=True),
                         '{"名称":"中文\\n\\\"","\U00010000":1,"\ue000":2}')

    def test_recursive_canonical_order_is_not_insertion_order(self):
        self.assertEqual(json_text({'z': [{'b': 1, 'a': 2}], 'a': 0}, sort=True),
                         '{"a":0,"z":[{"a":2,"b":1}]}')

    def test_integer_scoring_contract_unchanged(self):
        value = {'score': {'numerator': '9141', 'denominator': '100'}, 'count': 3, 'title': '中文'}
        self.assertEqual(digest(value), old_digest(value))

    def test_float_regression_detected_and_mutation_changes_digest(self):
        original = {'closure': 1.3726709029343796e-7}
        self.assertNotEqual(digest(original), old_digest(original))
        changed = {'closure': math.nextafter(original['closure'], math.inf)}
        self.assertNotEqual(digest(original), digest(changed))

    def test_nonfinite_rejected(self):
        for value in [math.inf, -math.inf, math.nan]:
            with self.assertRaises(ValueError):
                json_text({'value': value})


if __name__ == '__main__':
    unittest.main()
