import asyncio

from relay.worker.loop import Worker


class CountingWorker(Worker):
    def __init__(self, *, poll_interval: float) -> None:
        super().__init__(poll_interval=poll_interval)
        self.ticks = 0

    async def tick(self) -> None:
        self.ticks += 1


async def test_stop_interrupts_the_sleep_between_ticks() -> None:
    # A long poll interval: if stopping waited for the sleep to end, this would hang.
    worker = CountingWorker(poll_interval=60)
    task = asyncio.create_task(worker.run())
    await asyncio.sleep(0.05)

    worker.request_stop()
    await asyncio.wait_for(task, timeout=1)

    assert worker.ticks == 1
    assert worker.stopping


async def test_keeps_ticking_until_stopped() -> None:
    worker = CountingWorker(poll_interval=0.01)
    task = asyncio.create_task(worker.run())
    await asyncio.sleep(0.2)

    worker.request_stop()
    await asyncio.wait_for(task, timeout=1)

    assert worker.ticks >= 3


async def test_a_stop_requested_before_start_runs_no_ticks() -> None:
    worker = CountingWorker(poll_interval=0.01)
    worker.request_stop()

    await asyncio.wait_for(worker.run(), timeout=1)

    assert worker.ticks == 0


def test_worker_id_names_the_host_and_process() -> None:
    worker = Worker(poll_interval=1)

    host, _, pid = worker.worker_id.rpartition("-")
    assert host
    assert pid.isdigit()
