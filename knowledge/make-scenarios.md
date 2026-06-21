# Building Make.com Scenarios

## API Base
- Endpoint: `https://us2.make.com/api/v2/`
- Auth: `Authorization: Token {api-key}`

## Organizations & Teams
| Org ID | Name | Team ID | Team Name |
|--------|------|---------|-----------|
| 4658230 | D Caine Solutions LLC | 1164610 | Team Starr & Partners |
| 6593949 | Starr and Partners LLC | 1886138 | My Team |
| 6315018 | Automation Samples | 1783230 | My Team |
| 6962962 | Chris Pessy | 2025636 | My Team |
| 3074389 | Kane Minkus | 519889 | My Team |
| 5930708 | SL England, PLLC | 1651109 | My Team |

## Creating Scenarios
Both `blueprint` and `scheduling` must be **STRINGIFIED JSON** (strings, not objects).

```json
{
  "name": "Scenario Name",
  "teamId": 1164610,
  "scheduling": "{\"type\":\"indefinitely\",\"interval\":900}",
  "blueprint": "{\"name\":\"...\",\"metadata\":{\"version\":1},\"flow\":[...]}"
}
```

Blueprint MUST include `metadata.version`. Without it: 400 error.

## Activation
- **Start**: `POST /scenarios/{id}/start` (NOT `/activate` — that 404s)
- **Stop**: `POST /scenarios/{id}/stop`
- `isActive` and `islinked` are READ-ONLY

## Common Mistakes
- PATCH returning 200 does NOT mean the scenario will run — always test
- `http:ActionGetData` v3 does NOT exist — use `http:ActionSendData`
- Datastore IDs must be integers, not strings
- Connection params use `__IMTCONN__` prefix
