from fastapi import APIRouter, Depends
from contextlib import asynccontextmanager
import asyncio
import http.client
import socket
import json
import logging
from datetime import datetime
from typing import List
import psycopg
import os
import threading
import time

# Import push notification functionality
from .push_notify import send_push

router = APIRouter(prefix="/health")

DOCKER_SOCKET = "/var/run/docker.sock"

# Database connection
POSTGRES_URL = os.getenv(
    "POSTGRES_URL",
    "postgresql://boss:bosspass@postgres:5432/boss_db"
)

def get_pg_connection():
    return psycopg.connect(POSTGRES_URL)

def ensure_heal_log_table():
    with get_pg_connection() as conn:
        with conn.cursor() as cur:
            cur.execute("""
                CREATE TABLE IF NOT EXISTS boss_heal_log (
                    id SERIAL PRIMARY KEY,
                    container_name TEXT,
                    action TEXT,
                    timestamp TIMESTAMP DEFAULT NOW(),
                    success BOOLEAN
                );
            """)
        conn.commit()

ensure_heal_log_table()

# List of containers to monitor
CONTAINERS_TO_MONITOR = [
    "boss_postgres",
    "boss_redis",
    "boss_runner",
    "boss_api"
]

def log_heal_event(container_name: str, action: str, success: bool):
    """Log healing events to the database."""
    with get_pg_connection() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                INSERT INTO boss_heal_log (container_name, action, success)
                VALUES (%s, %s, %s)
                """,
                (container_name, action, success)
            )
        conn.commit()


def _docker_request(method: str, path: str) -> tuple:
    """Make an HTTP request to the Docker Engine API via Unix socket."""
    sock = None
    conn = None
    try:
        conn = http.client.HTTPConnection("localhost")
        sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        sock.connect(DOCKER_SOCKET)
        conn.sock = sock
        conn.request(method, path)
        resp = conn.getresponse()
        status = resp.status
        data = resp.read()
        return status, json.loads(data) if data else None
    finally:
        if conn:
            try:
                conn.close()
            except Exception:
                pass
        if sock:
            try:
                sock.close()
            except Exception:
                pass


def check_container_status(container_name: str) -> bool:
    """Check if a Docker container is running via Docker socket API."""
    try:
        import urllib.parse
        filters = json.dumps({"name": [container_name]})
        path = f"/containers/json?filters={urllib.parse.quote(filters)}"
        status, containers = _docker_request("GET", path)
        if status != 200 or not containers:
            return False
        for c in containers:
            names = c.get("Names", [])
            if f"/{container_name}" in names:
                return c.get("State") == "running"
        return False
    except Exception as e:
        print(f"[MONITOR] Docker socket error checking {container_name}: {e}", flush=True)
        return False


def get_all_containers() -> list:
    """Get status of all containers via Docker socket API."""
    try:
        status, containers = _docker_request("GET", "/containers/json?all=true")
        if status != 200 or not containers:
            return []
        result = []
        for c in containers:
            names = c.get("Names", [])
            name = names[0].lstrip("/") if names else "unknown"
            result.append({
                "name": name,
                "state": c.get("State", "unknown"),
                "status": c.get("Status", "unknown"),
                "image": c.get("Image", "unknown"),
            })
        return result
    except Exception as e:
        print(f"[MONITOR] Docker socket error listing containers: {e}", flush=True)
        return []


def start_container(container_name: str) -> bool:
    """Start a Docker container via Docker socket API."""
    try:
        status, _ = _docker_request("POST", f"/containers/{container_name}/start")
        return status in (204, 304)  # 204=started, 304=already running
    except Exception as e:
        print(f"[MONITOR] Docker socket error starting {container_name}: {e}", flush=True)
        return False

async def monitor_containers():
    """Background task to monitor containers and heal them if needed."""
    while True:
        try:
            for container_name in CONTAINERS_TO_MONITOR:
                is_running = check_container_status(container_name)
                
                if not is_running:
                    print(f"[MONITOR] Container {container_name} is DOWN. Attempting to heal...", flush=True)
                    
                    # Send push notification about the failure (P1 alert)
                    try:
                        send_push(
                            title=f"P1 Alert: {container_name} DOWN",
                            body=f"The {container_name} container has stopped and requires attention."
                        )
                    except Exception as push_error:
                        print(f"[MONITOR] Failed to send push notification: {push_error}", flush=True)
                    
                    success = start_container(container_name)
                    
                    if success:
                        print(f"[MONITOR] Successfully healed container {container_name}", flush=True)
                        log_heal_event(container_name, "start", True)
                        
                        # Send recovery notification
                        try:
                            send_push(
                                title=f"Recovery: {container_name} RESTORED",
                                body=f"The {container_name} container has been automatically restarted."
                            )
                        except Exception as push_error:
                            print(f"[MONITOR] Failed to send recovery notification: {push_error}", flush=True)
                    else:
                        print(f"[MONITOR] Failed to heal container {container_name}", flush=True)
                        log_heal_event(container_name, "start", False)
                        
                        # Send notification about failed healing attempt
                        try:
                            send_push(
                                title=f"CRITICAL: {container_name} FAILED TO RECOVER",
                                body=f"Automatic restart of {container_name} failed. Manual intervention required!"
                            )
                        except Exception as push_error:
                            print(f"[MONITOR] Failed to send critical alert notification: {push_error}", flush=True)
                else:
                    print(f"[MONITOR] Container {container_name} is running normally", flush=True)
            
            # Wait 60 seconds before next check
            await asyncio.sleep(60)
        
        except Exception as e:
            print(f"[MONITOR] Error in monitoring loop: {e}", flush=True)
            # Send notification about monitor failure
            try:
                send_push(
                    title="CRITICAL: Monitor System ERROR",
                    body=f"The container monitoring system encountered an error: {str(e)}"
                )
            except Exception as push_error:
                print(f"[MONITOR] Failed to send monitor error notification: {push_error}", flush=True)
            await asyncio.sleep(60)  # Continue monitoring even if there's an error

def start_monitor_background():
    """Start the monitoring task in a separate thread."""
    def run_monitor():
        # Run the async function in a new event loop
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        loop.run_until_complete(monitor_containers())
    
    monitor_thread = threading.Thread(target=run_monitor, daemon=True)
    monitor_thread.start()
    print("[MONITOR] Self-healing monitor started in background thread", flush=True)

@router.get("/full")
def get_full_health():
    """Return health status of all monitored containers and recent heal events."""
    # Get all containers from Docker socket API
    all_containers = get_all_containers()

    # Also check monitored containers specifically
    container_statuses = {}
    for container_name in CONTAINERS_TO_MONITOR:
        container_statuses[container_name] = check_container_status(container_name)

    # Get last 5 heal events
    with get_pg_connection() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT container_name, action, timestamp, success
                FROM boss_heal_log
                ORDER BY timestamp DESC
                LIMIT 5
                """
            )
            heal_events = cur.fetchall()

    formatted_events = [
        {
            "container_name": event[0],
            "action": event[1],
            "timestamp": str(event[2]),
            "success": event[3]
        }
        for event in heal_events
    ]

    return {
        "status": "ok",
        "container_statuses": container_statuses,
        "containers": all_containers,
        "heal_events": formatted_events,
        "timestamp": str(datetime.now())
    }