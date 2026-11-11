"""A real HTTP server on localhost that plays the part of a customer's receiver.

It is scripted per test: answer 500, answer 429 with Retry-After, redirect, hang
until the sender gives up, and so on. It speaks just enough HTTP/1.1 by hand so
that every misbehaviour is under the test's control.
"""

import asyncio
import contextlib
from dataclasses import dataclass, field


@dataclass(frozen=True)
class Reply:
    status: int = 200
    headers: dict[str, str] = field(default_factory=dict)
    body: bytes = b'{"received":true}'
    hang: bool = False  # accept the request, then never answer


@dataclass(frozen=True)
class Received:
    path: str
    headers: dict[str, str]
    body: bytes


class FakeReceiver:
    def __init__(self) -> None:
        self.requests: list[Received] = []
        self.default = Reply()
        self._script: list[Reply] = []
        self._server: asyncio.Server | None = None
        self._handlers: set[asyncio.Task[None]] = set()
        self.port = 0

    def reply_with(self, *replies: Reply) -> None:
        """Queue replies for the next requests; after them, ``default`` is used."""
        self._script.extend(replies)

    def url(self, path: str = "/hook", host: str = "127.0.0.1") -> str:
        return f"http://{host}:{self.port}{path}"

    async def start(self) -> None:
        self._server = await asyncio.start_server(self._handle, "127.0.0.1", 0)
        self.port = self._server.sockets[0].getsockname()[1]

    async def stop(self) -> None:
        if self._server is not None:
            self._server.close()
        for task in list(self._handlers):
            task.cancel()
        await asyncio.gather(*self._handlers, return_exceptions=True)
        if self._server is not None:
            await self._server.wait_closed()

    async def _handle(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        task = asyncio.current_task()
        assert task is not None
        self._handlers.add(task)
        try:
            head = (await reader.readuntil(b"\r\n\r\n")).decode("latin-1")
            request_line, *header_lines = head.split("\r\n")
            headers = {
                name.strip().lower(): value.strip()
                for name, _, value in (line.partition(":") for line in header_lines if line)
            }
            body = await reader.readexactly(int(headers.get("content-length", "0")))
            self.requests.append(Received(request_line.split(" ")[1], headers, body))

            reply = self._script.pop(0) if self._script else self.default
            if reply.hang:
                await asyncio.sleep(3600)
            extra = "".join(f"{name}: {value}\r\n" for name, value in reply.headers.items())
            writer.write(
                f"HTTP/1.1 {reply.status} Scripted\r\n"
                f"content-length: {len(reply.body)}\r\nconnection: close\r\n{extra}\r\n".encode()
                + reply.body
            )
            await writer.drain()
        except (asyncio.IncompleteReadError, ConnectionError):
            pass
        finally:
            self._handlers.discard(task)
            writer.close()
            with contextlib.suppress(ConnectionError, asyncio.CancelledError):
                await writer.wait_closed()
