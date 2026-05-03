---
name: roadmap-cli
description: Use this skill to manage the roadmap tool via CLI. Handles features, members, quarters, capacity allocations, and CSV export operations against a running roadmap server.
---

# Roadmap CLI Skill

## Prerequisites

- The roadmap server must be running (default: `http://localhost:3000`, start with `bun dev`)
- Set `ROADMAP_URL` environment variable to override the server URL
- Run all commands from the project root: `bun src/cli.ts <resource> <command> [args...]`

## Commands Reference

### Features

```sh
bun src/cli.ts features list
bun src/cli.ts features add <name>
bun src/cli.ts features rename <id> <name>
bun src/cli.ts features delete <id>
```

Output of `list`: `<id>\t<name>` per line, or `(no features)` if empty.  
Output of `add`/`rename`: `Created: <id>\t<name>` or `Renamed: <id>\t<name>`.  
Output of `delete`: `Deleted: <id>`.

### Members

```sh
bun src/cli.ts members list
bun src/cli.ts members add <name>
bun src/cli.ts members rename <id> <name>
bun src/cli.ts members delete <id>
```

Same output format as features.

### Quarters

```sh
bun src/cli.ts quarters list
bun src/cli.ts quarters add <year> <quarter>
bun src/cli.ts quarters delete <id>
```

`<quarter>` must be 1–4.  
Output of `list`: `<id>\t<year>-Q<quarter>` per line, or `(no quarters)` if empty.  
Output of `add`: `Created: <id>\t<year>-Q<quarter>`.

### Allocations

Capacity values are monthly (0.0–1.0). A quarter aggregates 3 months (max 3.0).  
A member's total capacity across all features in a single month cannot exceed 1.0.

```sh
# View all quarters and member allocations for a feature (JSON output)
bun src/cli.ts allocations feature-view <featureId>

# View all quarters and feature allocations for a member (JSON output)
bun src/cli.ts allocations member-view <memberId>

# Set or update total capacity budget for a feature in a quarter
# Existing member allocations are proportionally redistributed
bun src/cli.ts allocations update-total <featureId> <quarterId> <totalCapacity>

# Set a specific member's allocation for a feature in a quarter
# Silently capped at the member's remaining monthly capacity
bun src/cli.ts allocations update-member <featureId> <quarterId> <memberId> <capacity>

# Move all allocations for a feature from one quarter to another (merges if destination exists)
bun src/cli.ts allocations move <featureId> <fromQuarterId> <toQuarterId>
```

`feature-view` / `member-view` output JSON. `update-total` / `update-member` output JSON with the resulting state:

```json
{
  "featureId": 1,
  "quarterId": 2,
  "totalCapacity": 3.0,
  "unassignedCapacity": 1.0,
  "memberAllocations": [
    { "memberId": 1, "capacity": 1.0 },
    { "memberId": 2, "capacity": 1.0 }
  ]
}
```

`move` output: `Moved: featureId=<id> from=<id> to=<id>`.

### Export

```sh
bun src/cli.ts export features   # features × quarters CSV to stdout
bun src/cli.ts export members    # members × features × quarters CSV to stdout
```

Outputs CSV directly to stdout. Redirect to a file as needed:

```sh
bun src/cli.ts export features > features.csv
```

## Error Handling

Errors are printed to stderr and the process exits with code 1. Common causes:
- Server not running (connection refused) → start with `bun dev`
- Invalid ID (record not found) → verify with `list` first
- Capacity constraint violation → member's monthly total would exceed 1.0 (value is silently capped for `update-member`)

## Typical Workflow

```sh
# 1. Create features and members
bun src/cli.ts features add "Authentication"
bun src/cli.ts members add "Alice"
bun src/cli.ts members add "Bob"

# 2. Create a quarter
bun src/cli.ts quarters add 2025 2

# 3. Set total capacity budget for the feature in that quarter (e.g., 2 person-months)
bun src/cli.ts allocations update-total 1 1 2.0

# 4. Assign individual member allocations
bun src/cli.ts allocations update-member 1 1 1 1.0   # Alice: 1.0
bun src/cli.ts allocations update-member 1 1 2 1.0   # Bob: 1.0

# 5. Check current state
bun src/cli.ts allocations feature-view 1

# 6. Export to CSV
bun src/cli.ts export features
```
