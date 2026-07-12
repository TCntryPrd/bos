import os
import redis
from .models import IR Custom AIOSEvent

REDIS_HOST = os.getenv("REDIS_HOST", "redis")
REDIS_PORT = int(os.getenv("REDIS_PORT", "6379"))
STREAM_KEY = "boss:events"
CONSUMER_GROUP = "boss-reactor"


def get_redis():
    return redis.Redis(host=REDIS_HOST, port=REDIS_PORT, decode_responses=True)


def publish_event(event: IR Custom AIOSEvent, r: redis.Redis | None = None):
    conn = r or get_redis()
    conn.xadd(STREAM_KEY, event.to_stream())


def ensure_consumer_group(r: redis.Redis):
    try:
        r.xgroup_create(STREAM_KEY, CONSUMER_GROUP, id="0", mkstream=True)
    except redis.exceptions.ResponseError as e:
        if "BUSYGROUP" not in str(e):
            raise


def consume_events(consumer_name: str, count: int = 10, block_ms: int = 2000, r: redis.Redis | None = None):
    conn = r or get_redis()
    ensure_consumer_group(conn)
    results = conn.xreadgroup(
        CONSUMER_GROUP, consumer_name, {STREAM_KEY: ">"}, count=count, block=block_ms
    )
    events = []
    if results:
        for stream_name, entries in results:
            for stream_id, entry in entries:
                events.append((stream_id, IR Custom AIOSEvent.from_stream(entry)))
    return events


def ack_event(stream_id: str, r: redis.Redis | None = None):
    conn = r or get_redis()
    conn.xack(STREAM_KEY, CONSUMER_GROUP, stream_id)
