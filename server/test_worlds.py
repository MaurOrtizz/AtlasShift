"""Run with: python -m unittest discover -s server -p 'test_*.py'."""
import asyncio
import json
import unittest

from sqlalchemy import text
from sqlmodel import Session, create_engine
from sqlmodel.pool import StaticPool

from database import create_db, get_session
from main import app


class WorldAPITests(unittest.TestCase):
    def setUp(self):
        self.engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
        create_db(self.engine)

        def session_override():
            with Session(self.engine) as session:
                yield session

        app.dependency_overrides[get_session] = session_override

    def tearDown(self):
        app.dependency_overrides.clear()
        self.engine.dispose()

    def request(self, method, path, body=None):
        """Exercise the real ASGI routes without another HTTP dependency."""
        async def run():
            messages = []

            async def receive():
                return {"type": "http.request", "body": json.dumps(body).encode() if body is not None else b"", "more_body": False}

            async def send(message):
                messages.append(message)

            await app({
                "type": "http", "asgi": {"version": "3.0"}, "http_version": "1.1",
                "method": method, "scheme": "http", "path": path, "raw_path": path.encode(),
                "query_string": b"", "root_path": "", "headers": [(b"content-type", b"application/json")],
                "server": ("test", 80), "client": ("test", 1234),
            }, receive, send)
            status = next(message["status"] for message in messages if message["type"] == "http.response.start")
            content = b"".join(message.get("body", b"") for message in messages)
            return status, json.loads(content)

        return asyncio.run(run())

    def project(self):
        polygon = {"type": "Polygon", "coordinates": [[[0, 0], [1, 0], [1, 1], [0, 0]]]}
        return {
            "name": "Custom world", "schema_version": 1,
            "base_map": {"type": "FeatureCollection", "features": [
                {"type": "Feature", "properties": {"name": "Land"}, "geometry": polygon},
                {"type": "Feature", "properties": {"name": "Sea", "featureType": "sea"}, "geometry": polygon},
            ]},
            "edits": {"Land": {"name": "Renamed", "color": "#123456"}},
            "background_image": "/background.png", "background_bounds": [[-1, 1], [1, 1], [1, -1], [-1, -1]],
            "allow_overlapping": True,
        }

    def test_project_round_trip_and_explicit_deletion(self):
        payload = self.project()
        status, created = self.request("POST", "/worlds", payload)
        self.assertEqual(status, 200)
        path = f'/worlds/{created["id"]}'
        status, loaded = self.request("GET", path)
        self.assertEqual(status, 200)
        self.assertEqual({key: loaded[key] for key in payload}, payload)
        self.assertNotIn("geometry", loaded["edits"]["Land"])
        payload["edits"]["Land"]["geometry"] = None
        self.assertEqual(self.request("PUT", path, payload)[0], 200)
        self.assertIsNone(self.request("GET", path)[1]["edits"]["Land"]["geometry"])
        self.assertEqual(len(self.request("GET", "/worlds")[1]), 1)
        self.assertEqual(self.request("DELETE", path)[0], 200)
        self.assertEqual(self.request("GET", path)[0], 404)

    def test_legacy_world_and_upgrade(self):
        status, legacy = self.request("POST", "/worlds", {"name": "Legacy", "edits": {"Removed": {"geometry": None}}})
        self.assertEqual(status, 200)
        self.assertEqual(legacy["schema_version"], 0)
        self.assertIsNone(legacy["edits"]["Removed"]["geometry"])
        path = f'/worlds/{legacy["id"]}'
        self.assertEqual(self.request("PUT", path, self.project())[1]["schema_version"], 1)
        self.assertEqual(self.request("PUT", path, {"name": "Old client", "edits": {}})[0], 409)
        self.assertEqual(self.request("GET", path)[1]["base_map"], self.project()["base_map"])

    def test_invalid_version_map_and_name_are_rejected(self):
        for changes in [{"schema_version": 2}, {"base_map": None}, {"base_map": {}}, {"name": "  "}]:
            with self.subTest(changes=changes):
                self.assertEqual(self.request("POST", "/worlds", {**self.project(), **changes})[0], 422)

    def test_missing_world_returns_404(self):
        for method in ["GET", "PUT", "DELETE"]:
            self.assertEqual(self.request(method, "/worlds/999", self.project() if method == "PUT" else None)[0], 404)

    def test_additive_migration_preserves_old_rows_and_is_repeatable(self):
        old_engine = create_engine("sqlite://", poolclass=StaticPool)
        try:
            with old_engine.begin() as connection:
                connection.execute(text("CREATE TABLE world (id INTEGER PRIMARY KEY, name TEXT NOT NULL, edits TEXT NOT NULL)"))
                connection.execute(text("INSERT INTO world VALUES (1, 'Existing world', :edits)"), {"edits": '{"Gone":{"geometry":null}}'})
            create_db(old_engine)
            create_db(old_engine)
            with old_engine.connect() as connection:
                row = connection.execute(text("SELECT id, name, edits, project FROM world")).one()
                self.assertEqual(tuple(row), (1, "Existing world", '{"Gone":{"geometry":null}}', None))
        finally:
            old_engine.dispose()


if __name__ == "__main__":
    unittest.main()
