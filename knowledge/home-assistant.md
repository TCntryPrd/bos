# Home Assistant Operations

## Entity Map — Kevin's Home
| Device | Entity ID | Type | Notes |
|--------|-----------|------|-------|
| Living Room TV (actual) | remote.living_room_tv | remote | USE THIS for on/off |
| Living Room TV (media) | media_player.living_room_tv_2 | media_player | ON state = TV is on |
| Living Room TV (stale) | media_player.living_room_tv | media_player | Often shows OFF even when TV is on — DO NOT USE |
| Living Room Speaker | media_player.living_room_speaker | media_player | Google Home speaker |
| Bedroom Speaker | media_player.bedroom_speaker | media_player | |
| Home Group | media_player.home_group | media_player | All speakers |
| Voice PE | media_player.home_assistant_voice_0a9e20_media_player | media_player | IR Custom AIOS Voice PE |
| Voice PE LED | light.home_assistant_voice_0a9e20_led_ring | light | |

## Important
- "Turn off the TV" → use `remote.living_room_tv` with domain `remote`, NOT media_player
- Always verify state AFTER executing a command — don't just say "done"
- There are duplicate TV entities — the `_2` suffix one and the `remote.` one are the real ones
