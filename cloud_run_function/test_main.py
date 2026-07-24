from __future__ import annotations

import importlib.util
import json
import os
from pathlib import Path
import sys
import types
import unittest
from unittest import mock


functions_framework = types.ModuleType("functions_framework")
functions_framework.http = lambda function: function
sys.modules.setdefault("functions_framework", functions_framework)

module_spec = importlib.util.spec_from_file_location(
    "keepalive_main",
    Path(__file__).with_name("main.py"),
)
assert module_spec is not None
assert module_spec.loader is not None
main = importlib.util.module_from_spec(module_spec)
sys.modules[module_spec.name] = main
module_spec.loader.exec_module(main)


class FakeResponse:
    def __init__(self, status: int = 200):
        self.status = status

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return None

    def read(self, size: int) -> bytes:
        return b"{}"[:size]


class KeepAliveTest(unittest.TestCase):
    @mock.patch(
        "keepalive_main.urllib.request.urlopen",
        return_value=FakeResponse(),
    )
    def test_ping_space_uses_auth_only_for_private_space(self, urlopen):
        public = main.Space("public", "https://example.com/config")
        private = main.Space(
            "private",
            "https://private.example.com/config",
            requires_auth=True,
        )

        self.assertTrue(main.ping_space(public, "secret")["ok"])
        self.assertTrue(main.ping_space(private, "secret")["ok"])

        public_request = urlopen.call_args_list[0].args[0]
        private_request = urlopen.call_args_list[1].args[0]
        self.assertNotIn("Authorization", public_request.headers)
        self.assertEqual(
            private_request.get_header("Authorization"),
            "Bearer secret",
        )

    def test_private_space_without_token_is_a_safe_failure(self):
        private = main.Space(
            "private",
            "https://private.example.com/config",
            requires_auth=True,
        )

        result = main.ping_space(private, None)

        self.assertFalse(result["ok"])
        self.assertEqual(result["error"], "HF_TOKEN is not configured")

    @mock.patch("keepalive_main.ping_space")
    def test_handler_returns_success_when_all_spaces_respond(self, ping_space):
        ping_space.side_effect = lambda space, _token: {
            "name": space.name,
            "ok": True,
            "status": 200,
            "elapsed_ms": 1,
        }

        with mock.patch.dict(os.environ, {"HF_TOKEN": "secret"}):
            body, status, headers = main.keep_spaces_awake(None)

        payload = json.loads(body)
        self.assertEqual(status, 200)
        self.assertEqual(headers["Content-Type"], "application/json")
        self.assertTrue(payload["ok"])
        self.assertEqual(payload["spaces_checked"], 6)

    @mock.patch("keepalive_main.ping_space")
    def test_handler_requests_retry_when_any_space_fails(self, ping_space):
        ping_space.side_effect = lambda space, _token: {
            "name": space.name,
            "ok": space.name != "neutts-air-zerogpu",
            "status": 503 if space.name == "neutts-air-zerogpu" else 200,
            "elapsed_ms": 1,
        }

        body, status, _headers = main.keep_spaces_awake(None)

        self.assertEqual(status, 502)
        self.assertFalse(json.loads(body)["ok"])


if __name__ == "__main__":
    unittest.main()
