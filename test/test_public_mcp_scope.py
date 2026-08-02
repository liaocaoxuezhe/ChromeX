from __future__ import annotations

import unittest

from server import main


class PublicMcpScopeTests(unittest.IsolatedAsyncioTestCase):
    async def test_chromex_keeps_generic_names_with_chrome_only_scope(self):
        tools = await main.list_tools()
        names = {tool.name for tool in tools}

        self.assertIn("browser_session", names)
        self.assertIn("browser_diagnose", names)
        self.assertFalse(any(name.startswith("tabbit_") for name in names))
        self.assertTrue(all(
            "ChromeX only" in (tool.description or "")
            and "TabbitDance" in (tool.description or "")
            for tool in tools
        ))


if __name__ == "__main__":
    unittest.main()
