"""Roborock helper for the home dashboard (docs/03-sources-and-freshness.md § roborock).

Talks to the vacuum with python-roborock (the library Home Assistant uses), which does the
emailed-code sign-in and the robot's encrypted protocol. Read-only: it only sends
get_* commands. The `roborock` collector (TypeScript) asks it for a snapshot every hour and
does all parsing and storage.

  python helper.py login you@example.com   once: Roborock emails a code; saves the session
  python helper.py serve                   HTTP on :8080, on the compose network only

The session (a token, not the password) is saved to $ROBOROCK_DATA_DIR/session.json, mode
600. Nothing secret is logged.
"""

import asyncio
import json
import logging
import os
import pathlib
import sys
from typing import Any

from aiohttp import web
from roborock.data import UserData
from roborock.devices.device_manager import DeviceManager, UserParams, create_device_manager
from roborock.devices.file_cache import FileCache
from roborock.exceptions import RoborockException
from roborock.web_api import RoborockApiClient

DATA_DIR = pathlib.Path(os.environ.get("ROBOROCK_DATA_DIR", "/data"))
SESSION_FILE = DATA_DIR / "session.json"
CACHE_FILE = DATA_DIR / "device-cache.pkl"
DEVICE_ID = os.environ.get("ROBOROCK_DEVICE_ID", "").strip() or None
PORT = int(os.environ.get("PORT", "8080"))
SNAPSHOT_TIMEOUT_S = 90
MAX_CACHED_RECORDS = 200
LOGIN_HINT = "run the one-time Roborock login on the Pi (docs/06 § 5h)"

log = logging.getLogger("roborock-helper")


class NeedsLogin(Exception):
    """No saved session, or Roborock refused it."""


# --- login ---------------------------------------------------------------------------------


async def login(email: str) -> None:
    client = RoborockApiClient(email)
    await client.request_code()
    code = input(f"Roborock has emailed a code to {email}. Type it here: ").strip()
    user_data = await client.code_login(code)
    session = {"email": email, "base_url": await client.base_url, "user_data": user_data.as_dict()}
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    tmp = SESSION_FILE.with_suffix(".tmp")
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        json.dump(session, f)
    os.replace(tmp, SESSION_FILE)
    CACHE_FILE.unlink(missing_ok=True)  # device details from an older session
    print("Signed in. Now run: docker compose restart roborock")


# --- the robot -----------------------------------------------------------------------------


def _first(value: Any) -> Any:
    """Robot replies come as a one-element list or as the object itself."""
    return value[0] if isinstance(value, list) and len(value) == 1 else value


def _record_ids(summary: Any) -> list[int]:
    """Run ids (= start times) from get_clean_summary: a dict, or a list on older firmware."""
    summary = _first(summary)
    if isinstance(summary, dict):
        ids = summary.get("records", [])
    elif isinstance(summary, list) and len(summary) > 3:
        ids = summary[3]
    else:
        ids = []
    return [i for i in ids if isinstance(i, int)]


class Robot:
    def __init__(self) -> None:
        self._manager: DeviceManager | None = None
        self._cache = FileCache(CACHE_FILE)
        self._unauthorized = False
        self._lock = asyncio.Lock()
        # Finished runs never change, so each is fetched once.
        self._records: dict[int, Any] = {}

    def _on_unauthorized(self) -> None:
        self._unauthorized = True

    async def _device(self) -> Any:
        if self._unauthorized:
            raise NeedsLogin(f"Roborock refused the saved session: {LOGIN_HINT}")
        if self._manager is None:
            if not SESSION_FILE.exists():
                raise NeedsLogin(f"Not signed in to Roborock yet: {LOGIN_HINT}")
            session = json.loads(SESSION_FILE.read_text())
            params = UserParams(
                username=session["email"],
                user_data=UserData.from_dict(session["user_data"]),
                base_url=session.get("base_url"),
            )
            self._manager = await create_device_manager(
                params, cache=self._cache, mqtt_session_unauthorized_hook=self._on_unauthorized
            )
            await self._cache.flush()
        vacuums = [d for d in await self._manager.get_devices() if d.v1_properties is not None]
        if DEVICE_ID:
            vacuums = [d for d in vacuums if d.duid == DEVICE_ID]
        if not vacuums:
            raise RoborockException("No Roborock vacuum found on this account (or ROBOROCK_DEVICE_ID is wrong)")
        if len(vacuums) > 1:
            ids = ", ".join(d.duid for d in vacuums)
            raise RoborockException(f"Several vacuums on this account: set ROBOROCK_DEVICE_ID to one of {ids}")
        return vacuums[0]

    async def _reset(self) -> None:
        manager, self._manager = self._manager, None
        if manager is not None:
            try:
                await manager.close()
            except Exception:  # pylint: disable=broad-except
                pass

    async def snapshot(self) -> dict[str, Any]:
        async with self._lock:
            try:
                return await asyncio.wait_for(self._snapshot(), SNAPSHOT_TIMEOUT_S)
            except (RoborockException, asyncio.TimeoutError):
                await self._reset()  # reconnect from scratch next time
                raise

    async def _snapshot(self) -> dict[str, Any]:
        command = (await self._device()).v1_properties.command
        status = await command.send("get_status")
        summary = await command.send("get_clean_summary")
        maps = await command.send("get_multi_maps_list")
        ids = _record_ids(summary)
        for record_id in ids:
            if record_id not in self._records:
                self._records[record_id] = await command.send("get_clean_record", [record_id])
        for old in sorted(self._records)[:-MAX_CACHED_RECORDS]:
            del self._records[old]
        return {
            "status": _first(status),
            "summary": _first(summary),
            "maps": _first(maps),
            "records": [_first(self._records[i]) for i in ids],
        }


# --- HTTP ----------------------------------------------------------------------------------


def _error(status: int, message: str) -> web.Response:
    return web.json_response({"error": message}, status=status)


async def serve() -> None:
    robot = Robot()

    async def snapshot(_: web.Request) -> web.Response:
        try:
            return web.json_response(await robot.snapshot())
        except NeedsLogin as err:
            return _error(401, str(err))
        except asyncio.TimeoutError:
            return _error(504, f"The vacuum didn't answer within {SNAPSHOT_TIMEOUT_S} s")
        except RoborockException as err:
            log.warning("snapshot failed: %s", err)
            return _error(502, f"Roborock: {err}")

    async def health(_: web.Request) -> web.Response:
        return web.json_response({"ok": True, "signedIn": SESSION_FILE.exists()})

    app = web.Application()
    app.add_routes([web.get("/snapshot", snapshot), web.get("/health", health)])
    runner = web.AppRunner(app, access_log=None)
    await runner.setup()
    await web.TCPSite(runner, "0.0.0.0", PORT).start()
    log.info("listening on :%d (%s)", PORT, "signed in" if SESSION_FILE.exists() else "not signed in yet")
    await asyncio.Event().wait()


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    logging.getLogger("roborock").setLevel(logging.WARNING)  # its INFO lines can include account details
    match sys.argv[1:]:
        case ["login", email]:
            asyncio.run(login(email))
        case ["serve"] | []:
            asyncio.run(serve())
        case _:
            sys.exit("usage: helper.py login <email> | serve")


if __name__ == "__main__":
    main()
