"""Read-only Gmail wrapper — jarvis-os.

Usage:
    python gmail.py list [n]
    python gmail.py read <message_id>
    python gmail.py search <query>
"""
import base64
import os
import sys

from google.auth.transport.requests import Request
from google.oauth2.credentials import Credentials
from google_auth_oauthlib.flow import InstalledAppFlow
from googleapiclient.discovery import build

# Windows' console defaults stdout to the system codepage (cp1252 here), which
# can't encode arbitrary Unicode — an emoji in an email subject line crashes
# every print() downstream with UnicodeEncodeError. Reconfigure to UTF-8 with
# a safe fallback so an unusual character degrades the display instead of
# killing the whole command.
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

SCOPES = ["https://www.googleapis.com/auth/gmail.readonly"]

# Resolve against this file's location, not the caller's cwd — same fix as
# gcal.py (see jarvis-os.md, Day 8/9).
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
SERVER_DIR = os.path.dirname(SCRIPT_DIR)
CREDENTIALS_PATH = os.path.join(SERVER_DIR, "credentials.json")
# Separate token from gcal.py's server/token.json — keeps the Gmail scope
# isolated from the Calendar scope rather than one token holding both.
TOKEN_PATH = os.path.join(SERVER_DIR, "token_gmail.json")

DEFAULT_LIST_COUNT = 10


def get_credentials():
    creds = None
    if os.path.exists(TOKEN_PATH):
        creds = Credentials.from_authorized_user_file(TOKEN_PATH, SCOPES)
    if not creds or not creds.valid:
        if creds and creds.expired and creds.refresh_token:
            creds.refresh(Request())
        else:
            flow = InstalledAppFlow.from_client_secrets_file(CREDENTIALS_PATH, SCOPES)
            creds = flow.run_local_server(port=0)
        with open(TOKEN_PATH, "w") as f:
            f.write(creds.to_json())
    return creds


def _header(headers, name):
    for h in headers:
        if h.get("name", "").lower() == name.lower():
            return h.get("value", "")
    return ""


def _print_summary_line(service, message_id):
    msg = (
        service.users()
        .messages()
        .get(
            userId="me",
            id=message_id,
            format="metadata",
            metadataHeaders=["From", "Subject", "Date"],
        )
        .execute()
    )
    headers = msg.get("payload", {}).get("headers", [])
    sender = _header(headers, "From")
    subject = _header(headers, "Subject") or "(no subject)"
    date = _header(headers, "Date")
    print(f"{date}  {sender}  {subject}  [{message_id}]")


def cmd_list(service, args):
    count = int(args[0]) if args else DEFAULT_LIST_COUNT
    resp = service.users().messages().list(userId="me", maxResults=count).execute()
    messages = resp.get("messages", [])
    if not messages:
        print("No messages found.")
        return
    for m in messages:
        _print_summary_line(service, m["id"])


def cmd_search(service, args):
    if not args:
        print("Usage: python gmail.py search <query>")
        sys.exit(1)
    query = " ".join(args)
    resp = service.users().messages().list(userId="me", q=query).execute()
    messages = resp.get("messages", [])
    if not messages:
        print("No messages matched.")
        return
    for m in messages:
        _print_summary_line(service, m["id"])


def _decode(data):
    return base64.urlsafe_b64decode(data.encode("UTF-8")).decode("utf-8", errors="replace")


def _extract_body(payload):
    if payload.get("mimeType") == "text/plain" and payload.get("body", {}).get("data"):
        return _decode(payload["body"]["data"])
    for part in payload.get("parts", []) or []:
        if part.get("mimeType") == "text/plain" and part.get("body", {}).get("data"):
            return _decode(part["body"]["data"])
    for part in payload.get("parts", []) or []:
        text = _extract_body(part)
        if text:
            return text
    if payload.get("body", {}).get("data"):
        return _decode(payload["body"]["data"])
    return ""


def cmd_read(service, args):
    if not args:
        print("Usage: python gmail.py read <message_id>")
        sys.exit(1)
    message_id = args[0]
    msg = service.users().messages().get(userId="me", id=message_id, format="full").execute()
    headers = msg.get("payload", {}).get("headers", [])
    print(f"From:    {_header(headers, 'From')}")
    print(f"To:      {_header(headers, 'To')}")
    print(f"Subject: {_header(headers, 'Subject') or '(no subject)'}")
    print(f"Date:    {_header(headers, 'Date')}")
    print()
    print(_extract_body(msg.get("payload", {})) or "(no readable body)")


COMMANDS = {"list": cmd_list, "read": cmd_read, "search": cmd_search}


def main():
    if len(sys.argv) < 2 or sys.argv[1] not in COMMANDS:
        print("Usage: python gmail.py [list [n] | read <message_id> | search <query>]")
        sys.exit(1)
    command = sys.argv[1]
    args = sys.argv[2:]
    creds = get_credentials()
    service = build("gmail", "v1", credentials=creds)
    COMMANDS[command](service, args)


if __name__ == "__main__":
    main()
