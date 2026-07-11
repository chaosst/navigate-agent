#!/bin/bash
# Clean migrated Wiki.js pages before re-migration
cd "$(dirname "$0")/.."
source .env 2>/dev/null

for id in 1 2; do
  echo "Deleting page $id..."
  curl -s -X POST http://localhost:3003/graphql \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer ${WIKIJS_API_TOKEN}" \
    -d "{\"query\":\"mutation { pages { delete(id: $id) { responseResult { succeeded message } } } }\"}"
  echo ""
done
