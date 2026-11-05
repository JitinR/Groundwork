#!/usr/bin/python3
"""No privileges, network, native programs or application secrets are used."""
import base64
import hashlib
import json
import pathlib
import runpy
import unittest


BROKER = runpy.run_path(str(pathlib.Path(__file__).with_name("native-executor-broker.py")))
parse_request = BROKER["parse_request"]


class RequestBoundaryTests(unittest.TestCase):
    def source(self):
        data = b"synthetic CAD input"
        return {"version": 1, "op": "execute", "jobId": "a" * 32,
                "kind": "dxf-to-dwg", "input": {"bytes": base64.b64encode(data).decode(),
                "sourceArtifactId": "b" * 32, "sha256": hashlib.sha256(data).hexdigest()}}

    def encode(self, value):
        return json.dumps(value).encode()

    def rejects(self, value):
        with self.assertRaises((BROKER["Refused"], ValueError, UnicodeError, TypeError)):
            parse_request(value if isinstance(value, bytes) else self.encode(value))

    def test_valid_probe_and_hash_bound_input(self):
        self.assertEqual(parse_request(b'{"version":1,"op":"probe"}'), {"version": 1, "op": "probe"})
        value = self.source()
        self.assertEqual(parse_request(self.encode(value)), value)

    def test_exact_keys_scalar_identity_and_kind(self):
        for key, bad in (("version", True), ("jobId", "../host"), ("jobId", ["a" * 32]),
                         ("kind", "shell"), ("op", "run")):
            with self.subTest(key=key, bad=bad):
                value = self.source()
                value[key] = bad
                self.rejects(value)
        value = self.source()
        value["grant"] = "authority-credential-must-not-cross-this-boundary"
        self.rejects(value)

    def test_source_hash_base64_and_artifact_identity(self):
        for key, bad in (("sourceArtifactId", "../../server/.env"), ("sourceArtifactId", 1),
                         ("sha256", "0" * 64), ("bytes", ""), ("bytes", "YQ=== "),
                         ("bytes", True)):
            with self.subTest(key=key):
                value = self.source()
                value["input"][key] = bad
                self.rejects(value)

    def test_duplicate_keys_deep_objects_arrays_and_utf8(self):
        for raw in (b'{"version":1,"version":1,"op":"probe"}',
                    b'{"version":1,"op":"probe","ignored":{"deep":{}}}',
                    b'{"version":1,"op":"probe","ignored":[]}',
                    b'{"version":1,"op":"probe","ignored":"\xff"}',
                    b'{"version":1,"op":"probe"} trailing'):
            with self.subTest(raw=raw):
                self.rejects(raw)


if __name__ == "__main__":
    unittest.main()
