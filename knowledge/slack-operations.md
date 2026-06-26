# Slack Operations

## Bot Scopes Available
chat:write, chat:write.public, chat:write.customize, channels:read, groups:read, 
im:read, im:write, im:history, mpim:read, mpim:write, mpim:history,
reactions:read, reactions:write, reminders:read, reminders:write, 
emoji:read, metadata.message:read, app_mentions:read

## Channels
| ID | Name |
|----|------|
| C0A5BFG0RU7 | #all-the-kevin-starr-operating-system |
| C0A5BFMFTFZ | #new-channel |
| C0A5QTBM5B8 | #social |
| C0A708ULV3K | #social-media |

## Approved Channel List
Stored in runtime_config as `SLACK_APPROVED_CHANNELS` (JSON array).
Empty array = all channels allowed.
Manage via: `PUT /api/connectors/slack/channels` with `{"channels": ["#general", "C04ABCD"]}`

## Workspace
Team: The Kevin Starr Operating System
Bot user: starr_and_partners_ll
