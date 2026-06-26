# Airtable Operations

## Creating Bases
Use `boss_airtable_create_base`. Requires `schema.bases:write` scope on the PAT.
Must include at least one table with at least one field. First field = primary field.

## Field Types
singleLineText, multilineText, number, singleSelect, date, checkbox, email, url

For singleSelect:
```json
{ "name": "Status", "type": "singleSelect", "options": { "choices": [{"name": "Draft"}, {"name": "Active"}] } }
```

## Creating Tables in Existing Bases
Use `boss_airtable_create_table` with base_id, name, and fields array.

## Limitations
- Cannot create interfaces, views, filters, formulas, or rollups via API during creation
- A default grid view is auto-created for each table
- Some bases may return 403 even with correct token — check base-level sharing settings
