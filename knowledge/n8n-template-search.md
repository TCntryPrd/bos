# n8n Template Search — Search Before Building

## Rule: ALWAYS search templates before building an n8n workflow from scratch.

Building from a template costs ~50% fewer tokens than generating from nothing.

## Template Sources (search in this order)

### 1. n8n Official Templates API
```
GET https://api.n8n.io/api/templates/search?q={query}&limit=10
```
Returns workflows with: id, name, description, totalViews, nodes used.

To get the full template JSON:
```
GET https://api.n8n.io/api/templates/workflows/{id}
```

### 2. n8nEmpire.com (Kevin's account)
Website: https://n8nempire.com
Search the site for relevant templates. Kevin has an account there.

### 3. Local n8n Instance
Check existing workflows on the local n8n for similar patterns:
```
GET http://localhost:5678/api/v1/workflows
```
Headers: X-N8N-API-KEY from env

## Workflow: Template-First Building

1. **User asks for an n8n workflow** (e.g., "build me a Gmail to Slack notification")
2. **Search templates first:**
   - Search n8n API: `?q=gmail+slack`
   - Check local n8n for similar existing workflows
3. **If template found:**
   - Fetch the full template JSON
   - Show user: "Found template: [name] with [X] views. Want me to customize it?"
   - Modify the template to match their needs
   - Import to local n8n via API
4. **If no template found:**
   - Build from scratch using known node patterns
   - Log the new pattern for future reuse

## Cost Savings
- Template modification: ~150K tokens avg (~$0.22 Haiku, ~$0.82 Sonnet)
- From scratch: ~300K tokens avg (~$0.44 Haiku, ~$1.65 Sonnet)
- Template-first cuts cost in half
