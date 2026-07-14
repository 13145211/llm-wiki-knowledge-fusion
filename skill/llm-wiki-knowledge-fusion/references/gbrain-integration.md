# GBrain Integration Protocol

## Overview

GBrain serves as the L2 (graph index) layer in the three-layer architecture. It does NOT store full knowledge — only entity summaries and links to the LLM-Wiki (L1).

## Data Flow

```
LLM-Wiki (L1)
    |
    +---> [Signal capture] ---> GBrain (L2)
              |
              +---> Entity page (3-5 sentence summary + wiki link)
              +---> Relation (entity A --relation--> entity B)
              +---> Timeline event (date + description + wiki link)
```

**One-way only**: LLM-Wiki → GBrain. GBrain never triggers wiki page creation.

## Entity Types in GBrain

| Type | Description | LLM-Wiki Link |
|------|-------------|---------------|
| `catalyst` | Catalyst system (e.g., Cu-CeO2, Pt-Al2O3) | `wiki/concepts/{slug}` |
| `material` | Support material (e.g., CeO2, Al2O3, ZrO2) | `wiki/concepts/{slug}` |
| `author` | Researcher | `wiki/entities/{slug}` |
| `institution` | University, lab, company | `wiki/entities/{slug}` |
| `concept` | Mechanism, property, idea | `wiki/concepts/{slug}` |
| `method` | Experimental or computational technique | `wiki/methods/{slug}` |
| `project` | Research project or grant | `wiki/meta/{slug}` |
| `event` | Conference, publication, discovery | `wiki/meta/{slug}` |

## GBrain Page Format

Each GBrain entity page linked to LLM-Wiki:

```markdown
# <Entity Name>

- **Type**: <type>
- **LLM-Wiki**: → [[F:\path\to\wiki\page]]
- **Summary**: <3-5 sentences describing what this entity is and why it matters>
- **Key papers**: <count> papers in LLM-Wiki
- **Relations**:
  - <relation-type> <target-entity>
  - <relation-type> <target-entity>
- **Last updated**: YYYY-MM-DD
- **Confidence**: high | medium | low
```

## CLI Commands

### Add Entity

```bash
node <gbrain-path>/scripts/add.mjs entity \
  --id "<slug>" \
  --type "<type>" \
  --label "<Display Name>" \
  --attrs '{"llm_wiki":"<absolute-path>","summary":"<summary>","key_papers":<count>}'
```

### Add Relation

```bash
node <gbrain-path>/scripts/add.mjs rel \
  --from "<source-id>" \
  --to "<target-id>" \
  --rel "<relation-type>"
```

Relation types: `owns`, `uses`, `depends_on`, `related_to`, `part_of`, `created`, `manages`, `knows`, `located_in`, `has`

### Quick Add

```bash
node <gbrain-path>/scripts/add.mjs quick "<Label>:<type>" --parent "<parent-id>" --category "<cat>"
```

### Search

```bash
node <gbrain-path>/scripts/query.mjs find "<text>"
node <gbrain-path>/scripts/query.mjs traverse "<id>" --depth 3
```

## Signal Capture Rules

### When to Write to GBrain

| Trigger | Action | Example |
|---------|--------|---------|
| New source mentions a catalyst | Add/update `catalyst` entity | `Cu-CeO2` |
| New source mentions an author | Add/update `author` entity | `John Smith` |
| New source mentions a method | Add/update `method` entity | `in-situ DRIFTS` |
| New source reveals a mechanism | Add/update `concept` entity | `Mars-van Krevelen` |
| Two entities interact in a paper | Add relation | `Cu-CeO2 --uses--> CeO2` |
| Discovery date mentioned | Add timeline event | `2024-03: Cu-CeO2 active site identified` |

### When NOT to Write to GBrain

- Do NOT write full paper summaries
- Do NOT write concept explanations longer than 5 sentences
- Do NOT create GBrain pages for sources (sources stay in LLM-Wiki)
- Do NOT write raw text or quotes from papers
- Do NOT duplicate content that exists in LLM-Wiki

## Sync Workflow

### After Each Source Ingest

1. Extract entities from the new source summary
2. For each entity:
   - Check if GBrain page exists (query by id)
   - If exists: update summary, increment key_papers count, update last_updated
   - If new: create page with summary + wiki link
3. For each pair of interacting entities:
   - Add relation if not already exists
4. Update `wiki/hot.md` with recently active entities

### Monthly Review

1. Run GBrain dream cycle (if configured)
2. Check for orphaned GBrain pages (no recent wiki link updates)
3. Verify all GBrain pages have valid LLM-Wiki links
4. Consolidate duplicate entities

## Configuration

### GBrain Config

Ensure `brain_dir` points to your GBrain directory:

```bash
node <gbrain-path>/scripts/config.mjs get brain_dir
node <gbrain-path>/scripts/config.mjs set brain_dir "C:\Users\<user>\gbrain"
```

### Embedding Config

GBrain uses embeddings for semantic search. Ensure configured:

```bash
node <gbrain-path>/scripts/config.mjs get embedding.provider
node <gbrain-path>/scripts/config.mjs set embedding.max_batch_tokens 8192
```

## Troubleshooting

### GBrain page exists but wiki link is stale

- Update the `llm_wiki` attr: `node .../add.mjs entity --id "<slug>" --attrs '{"llm_wiki":"<new-path>"}'`

### Entity has no wiki page yet

- Create the wiki page first, then sync to GBrain
- Do NOT create GBrain page without wiki link

### Duplicate entities

- Use `query.mjs find` to search for duplicates
- Consolidate by updating one entity and removing the other
- Update all relations to point to the canonical entity

### Sync script fails

- Check GBrain is running: `node <gbrain-path>/scripts/config.mjs`
- Check brain_dir exists and is writable
- Verify embedding provider is configured
