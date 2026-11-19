"""Unit tests for tt_digest (stdlib unittest). Run: python3 -I verify/python/test_tt_digest.py"""

import os
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)  # -I leaves the script's own folder off sys.path

import tt_digest  # noqa: E402

VECTORS = os.path.join(HERE, "..", "..", "vectors", "digest-1.json")


class Vectors(unittest.TestCase):
    def test_every_vector(self):
        count, problems = tt_digest.check_vectors(VECTORS)
        self.assertGreater(count, 10)
        self.assertEqual(problems, [])


class Numbers(unittest.TestCase):
    def test_ecmascript_forms(self):
        cases = {1.0: "1", -0.0: "0", 1e-7: "1e-7", 1e-6: "0.000001", 1e21: "1e+21", 1e20: "100000000000000000000",
                 123.456: "123.456", 5e-324: "5e-324", 0.1: "0.1", -1.5: "-1.5", 2 ** 53 + 1: "9007199254740992",
                 1.7976931348623157e308: "1.7976931348623157e+308"}
        for value, text in cases.items():
            self.assertEqual(tt_digest.canonicalize(value), text, value)

    def test_infinity_refused(self):
        with self.assertRaises(tt_digest.CanonicalizationError):
            tt_digest.canonicalize(float("inf"))


class Order(unittest.TestCase):
    def test_utf16_order_not_code_point_order(self):
        self.assertEqual(tt_digest.canonicalize({"דּ": 1, "\U0001F600": 2}), '{"\U0001F600":2,"דּ":1}')


class Strings(unittest.TestCase):
    def test_lone_surrogate_refused(self):
        for bad in ({"t": "\ud800"}, {"\udc00": 1}):
            with self.assertRaises(tt_digest.CanonicalizationError):
                tt_digest.canonicalize(bad)

    def test_escapes(self):
        self.assertEqual(tt_digest.canonicalize("a\u0001\u007f "), '"a\\u0001\u007f "')


if __name__ == "__main__":
    unittest.main()
