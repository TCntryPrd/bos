#!/usr/bin/env bash
# IR Custom AIOS v2 — Initialize Weaviate Collections
# Usage: ./init-schema.sh [WEAVIATE_URL] [TENANT_PREFIX]
# Example: ./init-schema.sh http://localhost:8080
# Example: ./init-schema.sh http://localhost:8080 tenant_abc

set -euo pipefail

WEAVIATE_URL="${1:-http://localhost:8080}"
TENANT_PREFIX="${2:-}"
SCHEMA_FILE="$(dirname "$0")/schema.json"

if [ ! -f "$SCHEMA_FILE" ]; then
    echo "ERROR: schema.json not found at $SCHEMA_FILE"
    exit 1
fi

echo "Initializing Weaviate collections at $WEAVIATE_URL"
[ -n "$TENANT_PREFIX" ] && echo "Using tenant prefix: $TENANT_PREFIX"

# Wait for Weaviate to be ready
for i in $(seq 1 30); do
    if curl -sf "$WEAVIATE_URL/v1/.well-known/ready" > /dev/null 2>&1; then
        echo "Weaviate is ready"
        break
    fi
    echo "Waiting for Weaviate... ($i/30)"
    sleep 2
done

# Read collections from schema.json and create each one
COLLECTIONS=$(python3 -c "
import json, sys
with open('$SCHEMA_FILE') as f:
    schema = json.load(f)
for c in schema['collections']:
    print(c['class'])
" 2>/dev/null || jq -r '.collections[].class' "$SCHEMA_FILE")

for CLASS_NAME in $COLLECTIONS; do
    FULL_NAME="${TENANT_PREFIX:+${TENANT_PREFIX}_}${CLASS_NAME}"

    # Check if collection already exists
    EXISTS=$(curl -sf "$WEAVIATE_URL/v1/schema/$FULL_NAME" 2>/dev/null && echo "yes" || echo "no")

    if [ "$EXISTS" = "yes" ]; then
        echo "Collection $FULL_NAME already exists, skipping"
        continue
    fi

    # Extract collection definition and optionally rename
    BODY=$(python3 -c "
import json, sys
with open('$SCHEMA_FILE') as f:
    schema = json.load(f)
for c in schema['collections']:
    if c['class'] == '$CLASS_NAME':
        c['class'] = '$FULL_NAME'
        # Remove description from properties for API compatibility
        for p in c.get('properties', []):
            p.pop('description', None)
        c.pop('_comment', None)
        print(json.dumps(c))
        break
" 2>/dev/null || jq --arg name "$FULL_NAME" '.collections[] | select(.class == "'"$CLASS_NAME"'") | .class = $name | .properties |= map(del(.description))' "$SCHEMA_FILE")

    echo "Creating collection: $FULL_NAME"
    RESPONSE=$(curl -sf -X POST "$WEAVIATE_URL/v1/schema" \
        -H "Content-Type: application/json" \
        -d "$BODY" 2>&1) || {
        echo "  ERROR creating $FULL_NAME: $RESPONSE"
        continue
    }
    echo "  Created $FULL_NAME"
done

echo "Weaviate schema initialization complete"
