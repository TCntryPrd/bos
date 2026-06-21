# Notion Operations

## Connection
- API Key in runtime_config as NOTION_API_KEY
- Header: `Authorization: Bearer {key}`, `Notion-Version: 2022-06-28`

## Creating Records
Use `boss_notion_create_page` with the database ID and properties matching the database schema.
Always `boss_notion_search` first to find the correct database and understand its property structure.

## Current Workspace Content
- 4 databases: Department Head Tasks, AImee's Desk, Worker Tasks, Lead Tasks
- 12 pages: AI Operations Factory system documentation
- Integration name in Notion: "OpenClaw (3-9-26)"

## Common Issues
- Database must have the Notion integration connected (shared with the API connection)
- Property names must match exactly (case-sensitive)
- Page creation needs parent database_id, not page_id
