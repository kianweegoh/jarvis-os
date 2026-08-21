"""Minimal Google Calendar read script — jarvis-os Day 9.

Usage: python gcal.py today
"""
import datetime
import os
import sys

from google.auth.exceptions import RefreshError
from google.auth.transport.requests import Request
from google.oauth2.credentials import Credentials
from google_auth_oauthlib.flow import InstalledAppFlow
from googleapiclient.discovery import build

SCOPES = ["https://www.googleapis.com/auth/calendar.readonly"]

# Resolve against this file's location, not the caller's cwd — a prior
# filename mismatch here caused a silent config bug (see jarvis-os.md, Day 8).
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
SERVER_DIR = os.path.dirname(SCRIPT_DIR)
CREDENTIALS_PATH = os.path.join(SERVER_DIR, "credentials.json")
TOKEN_PATH = os.path.join(SERVER_DIR, "token.json")


def get_credentials():
    creds = None
    if os.path.exists(TOKEN_PATH):
        creds = Credentials.from_authorized_user_file(TOKEN_PATH, SCOPES)
    if not creds or not creds.valid:
        refreshed = False
        if creds and creds.expired and creds.refresh_token:
            try:
                creds.refresh(Request())
                refreshed = True
            except RefreshError:
                # Refresh token itself was rejected (commonly: OAuth consent
                # screen in "Testing" mode, where refresh tokens hard-expire
                # 7 days after issuance regardless of use) — fall through to
                # a fresh interactive consent instead of crashing.
                print("Refresh token invalid/expired — re-authenticating...", file=sys.stderr)
        if not refreshed:
            flow = InstalledAppFlow.from_client_secrets_file(CREDENTIALS_PATH, SCOPES)
            creds = flow.run_local_server(port=0)
        with open(TOKEN_PATH, "w") as f:
            f.write(creds.to_json())
    return creds


def list_today(service):
    now = datetime.datetime.now().astimezone()
    start = now.replace(hour=0, minute=0, second=0, microsecond=0)
    end = start + datetime.timedelta(days=1)
    events_result = (
        service.events()
        .list(
            calendarId="primary",
            timeMin=start.isoformat(),
            timeMax=end.isoformat(),
            singleEvents=True,
            orderBy="startTime",
        )
        .execute()
    )
    events = events_result.get("items", [])
    if not events:
        print("No events today.")
        return
    for event in events:
        event_start = event["start"].get("dateTime", event["start"].get("date"))
        print(f"{event_start}  {event.get('summary', '(no title)')}")


def main():
    command = sys.argv[1] if len(sys.argv) > 1 else "today"
    creds = get_credentials()
    service = build("calendar", "v3", credentials=creds)
    if command == "today":
        list_today(service)
    else:
        print(f"Unknown command: {command}")
        sys.exit(1)


if __name__ == "__main__":
    main()
