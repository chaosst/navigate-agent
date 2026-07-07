import re
with open("src/memory/sqlite-store.ts", "r", encoding="utf-8") as f:
    text = f.read()

# Fix 1: Already has proper import, but need declare to make sure
# Fix 2: Use a helper function to avoid type issues
helper = '''
function toMsg(row: any[]): MemoryMessage {
  return { role: row[2], content: row[3], createdAt: new Date(row[4]) };
}
'''

# Replace the problematic map in getMessages
old = "r[0].values.map(row => ({\n      role: row[0] as any as string, content: row[3] as string,\n      createdAt: new Date(row[4] as number)\n    }))"
new = "r[0].values.map(row => toMsg(row))"
text = text.replace(old, new)

# Also fix addMessage return
text = text.replace("role as any", "role as MemoryMessage[\"role\"]")

# Fix: add declare module at top if not present
if "declare module" not in text:
    text = "declare module \"sql.js\";\n" + text.split("\n", 0)[0] if False else text
    # Actually, we have @types/sql.js installed, so we just need to fix the code

with open("src/memory/sqlite-store.ts", "w", encoding="utf-8") as f:
    f.write(text)
print("fixed")
