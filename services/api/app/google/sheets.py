"""Direct Google Sheets API client using stored OAuth tokens."""

import httpx
import json
from .oauth import get_valid_token

SHEETS_API = "https://sheets.googleapis.com/v4/spreadsheets"


def _headers(email: str | None = None) -> dict:
    token = get_valid_token("sheets", email)
    if not token:
        raise ConnectionError("Google Sheets not connected.")
    return {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}


def read_sheet(spreadsheet_id: str, range: str, email: str | None = None) -> list[list]:
    with httpx.Client(timeout=15) as client:
        resp = client.get(
            f"{SHEETS_API}/{spreadsheet_id}/values/{range}",
            headers=_headers(email),
        )
        resp.raise_for_status()
    return resp.json().get("values", [])


def append_rows(spreadsheet_id: str, range: str, rows: list[list], email: str | None = None) -> dict:
    with httpx.Client(timeout=15) as client:
        resp = client.post(
            f"{SHEETS_API}/{spreadsheet_id}/values/{range}:append",
            headers=_headers(email),
            params={"valueInputOption": "USER_ENTERED", "insertDataOption": "INSERT_ROWS"},
            json={"values": rows},
        )
        resp.raise_for_status()
    return resp.json()


def update_cells(spreadsheet_id: str, range: str, values: list[list], email: str | None = None) -> dict:
    with httpx.Client(timeout=15) as client:
        resp = client.put(
            f"{SHEETS_API}/{spreadsheet_id}/values/{range}",
            headers=_headers(email),
            params={"valueInputOption": "USER_ENTERED"},
            json={"values": values},
        )
        resp.raise_for_status()
    return resp.json()
