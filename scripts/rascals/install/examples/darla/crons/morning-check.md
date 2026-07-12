Morning check.

1. Fetch your pending tasks:
   `curl -sH 'X-BOSS-Internal: true' -H 'X-Tenant-ID: default' http://127.0.0.1:8001/api/tasks/agent/darla`
2. If any tasks are `pending`, pick the highest priority one and `POST /api/tasks/{id}/start`.
3. If any are `active`, continue working on them.
4. Check d.caine@dcaine.com calendar for meetings today involving Debbie
   Wooldridge or TTC. If a meeting is within 2 hours, prep a briefing.
5. If no tasks and no meetings: reply "Nothing to do this morning." and stop.

When finished, call `POST /api/tasks/{id}/advance` with a short `output`
summary, or create a new task (`POST /api/tasks`) if you discovered work.
