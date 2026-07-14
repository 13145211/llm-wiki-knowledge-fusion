---
name: llm-wiki-knowledge-fusion
description: >
  A three-layer knowledge management architecture that fuses LLM-Wiki (Obsidian-based knowledge compilation layer), 
  GBrain (entity-relationship graph index layer), and OpenClaw Memory (session log layer). 
  Use when: (1) building or upgrading an LLM-Wiki knowledge base for research literature, (2) integrating GBrain 
  as a graph index layer with an existing LLM-Wiki, (3) designing a knowledge fusion workflow between multiple 
  persistent knowledge systems, (4) migrating from a flat literature-reading workflow to a structured knowledge 
  compilation pipeline, (5) setting up cross-system entity linking and bidirectional references.
---

# LLM-Wiki Knowledge Fusion

## Overview

This skill implements a three-layer knowledge management architecture:

| Layer | System | Role | Stores |
|-------|--------|------|--------|
| L0 Session Memory | OpenClaw Memory | Session continuity, logs | Daily operation logs, preferences, project status |
| L1 Knowledge Compilation | LLM-Wiki (Obsidian) | Structured knowledge base | Source summaries, concepts, entities, comparisons, synthesis |
| L2 Graph Index | GBrain | Entity-relationship graph + semantic search | Entity pages (people, orgs, concepts, catalysts), relations, timeline |

**Core principle**: Each layer has a single responsibility. Data flows one-way: raw sources → LLM-Wiki (knowledge compilation) → GBrain (entity index). Avoid circular writes.

## When to Use

- You have an existing LLM-Wiki with many source summaries but empty concepts/entities/comparisons directories
- You want to add GBrain as an entity-relationship index layer on top of an LLM-Wiki
- You are doing bulk literature reading and want the output to feed into a structured knowledge pipeline
- You need cross-system entity linking (e.g., a catalyst mentioned in 200 papers should have one entity page)
- You want Obsidian visual browsing over your LLM-Wiki while keeping GBrain for semantic/relational queries

## Architecture

### Data Flow (One-Way)

```
Raw sources (PDFs, web pages, notes)
    |
    +---> LLM-Wiki/raw/          (immutable, human-curated)
    |           |
    |           +---> [Ingest/Reading] ---> wiki/sources/   (structured summaries)
    |                                           |
    |                                           +---> wiki/concepts/     (ideas, mechanisms, properties)
    |                                           +---> wiki/entities/     (people, organizations, catalysts)
    |                                           +---> wiki/methods/        (experimental/computational methods)
    |                                           +---> wiki/comparisons/    (side-by-side analyses)
    |                                           +---> wiki/synthesis/      (cross-source insights)
    |                                           |
    |                                           +---> [Signal capture] ---> GBrain pages
    |                                                                   (entity summaries + wiki links)
    |
    +---> OpenClaw memory/YYYY-MM-DD.md   (operation logs only)
                |
                +---> [Periodic promotion] ---> MEMORY.md (key decisions, preferences)
```

### Layer Boundaries

**L0 (OpenClaw Memory)** — Do NOT store structured knowledge here.
- Store: session logs, user preferences, current project status, tool configurations
- Do NOT store: paper summaries, concept definitions, entity details, synthesis arguments
- Migration: when knowledge appears in MEMORY.md, move it to LLM-Wiki and replace with a link

**L1 (LLM-Wiki)** — The knowledge master copy.
- Store: everything that constitutes "knowledge" about your domain
- Format: Markdown with YAML frontmatter, Obsidian `[[wikilink]]` syntax
- Index: `wiki/index.md` catalogs all pages; `wiki/overview.md` holds top-level synthesis
- Log: `wiki/log.md` records all maintenance operations

**L2 (GBrain)** — The index and search layer.
- Store: entity pages with 3-5 sentence summaries + `→ [[wiki/...]]` links
- Do NOT store: full paper summaries, long concept explanations, raw text
- Role: answer "what entities exist, how are they related, what happened when"
- Trigger: signal-detector captures new entities from LLM-Wiki updates

## Directory Structure

### LLM-Wiki Root

```
llm-wiki/
├── SCHEMA.md              # Single source of truth for operations
├── AGENTS.md              # Agent instructions (thin pointer to SCHEMA.md)
├── CLAUDE.md              # Claude Code instructions (thin pointer)
├── .gitignore             # Exclude raw/, cache/, .obsidian/workspace.json
├── .manifest.json         # SHA-256 hashes for deduplication
├── raw/                   # Immutable source documents (human curates, LLM reads only)
├── _templates/            # Templates for wiki page creation
│   ├── source.md          # Literature summary template
│   ├── entity.md          # Person/organization/catalyst template
│   ├── concept.md         # Idea/mechanism/property template
│   ├── method.md          # Experimental/computational method template
│   ├── comparison.md      # Side-by-side analysis template
│   ├── question.md        # Research question template
│   ├── gap.md             # Research gap template
│   ├── domain.md          # Domain overview template
│   ├── thesis.md          # Argument/thesis template
│   └── meta.md            # Meta-information template
└── wiki/                  # Maintained knowledge (LLM owns entirely)
    ├── index.md           # Content catalog with links
    ├── log.md             # Chronological activity log
    ├── overview.md        # Top-level synthesis
    ├── hot.md             # Recently active topics (cache)
    ├── sources/           # Source summaries (one per source document)
    ├── concepts/          # Concept pages (ideas, mechanisms, properties)
    ├── entities/          # Entity pages (people, organizations, catalysts, materials)
    ├── methods/           # Method pages (experimental, computational, analytical)
    ├── comparisons/       # Comparison pages (side-by-side analyses)
    ├── synthesis/         # Synthesis pages (cross-source insights, arguments)
    ├── gaps/              # Research gaps (identified but unaddressed questions)
    ├── questions/           # Research questions (active inquiries)
    ├── domains/           # Domain overviews (sub-field summaries)
    ├── papers/            # Paper-specific deep dives (optional)
    └── meta/              # Meta-information (schema evolution, conventions)
```

### GBrain Integration

GBrain stores entity pages at `C:\Users\<user>\gbrain\brain\pages\` (or configured `brain_dir`).
Each entity page linked to LLM-Wiki follows this format:

```markdown
# <Entity Name>

- **Type**: catalyst | author | institution | concept | method | material
- **LLM-Wiki**: → [[F:\xz-wiki-upgraded\wiki\concepts\<slug>]]
- **Summary**: <3-5 sentences>
- **Key papers**: <count> papers
- **Relations**: <relation-type> <target-entity>
- **Last updated**: YYYY-MM-DD
```

## Operations

### 1. Ingest (Reading a Source)

**Trigger**: User provides a source or requests literature reading.

**Workflow**:
1. Read the source completely (PDF, web, or text)
2. Discuss key takeaways with user (optional but recommended)
3. Create/update source summary → `wiki/sources/{slug}.md`
4. Extract entities → create/update `wiki/entities/{entity}.md`
5. Extract concepts → create/update `wiki/concepts/{concept}.md`
6. Extract methods → create/update `wiki/methods/{method}.md`
7. Create comparisons if relevant → `wiki/comparisons/`
8. Update synthesis if patterns emerge → `wiki/synthesis/`
9. Update `wiki/index.md` with all new/changed pages
10. Update `wiki/overview.md` if top-level understanding shifts
11. Append entry to `wiki/log.md`
12. **Signal capture**: write entity summaries to GBrain with wiki links

**A single source may touch 10-15 wiki pages.**

### 2. Query (Asking a Question)

**Trigger**: User asks a research question.

**Workflow**:
1. Read `wiki/index.md` to identify relevant pages
2. Read the relevant pages (sources, concepts, entities, comparisons, synthesis)
3. Synthesize an answer with citations (`[[page-name]]`)
4. Optionally: if the answer is valuable, file it as a new question page in `wiki/questions/`
5. If the answer reveals a gap, file it in `wiki/gaps/`

### 3. Entity Extraction (From Sources to Concepts/Entities)

**Trigger**: After creating a source summary, or during bulk backfill.

**Rules**:
- **Authors**: one `wiki/entities/{author-name}.md` per author, linked from all their papers
- **Institutions**: one `wiki/entities/{institution}.md` per organization
- **Catalysts/Materials**: one `wiki/concepts/{material}.md` per distinct catalyst system (e.g., `Cu-CeO2`, `Pt-Al2O3`)
- **Methods**: one `wiki/methods/{method}.md` per technique (e.g., `DRIFTS`, `XANES`, `DFT`)
- **Concepts**: one `wiki/concepts/{concept}.md` per mechanism, property, or idea

**Entity page format**:
```markdown
---
title: <Name>
type: entity | concept | method
created: YYYY-MM-DD
updated: YYYY-MM-DD
sources: [<related-source-slugs>]
tags: [<tags>]
---

## Overview
<2-3 sentence summary>

## Key Papers
- [[../sources/<slug>]] — <brief note>

## Related Entities
- [[<other-entity>]] — <relation description>

## Related Concepts
- [[<concept>]] — <relation description>
```

### 4. GBrain Sync (One-Way)

**Trigger**: After creating/updating a wiki entity or concept page.

**Workflow**:
1. Generate a 3-5 sentence summary of the entity/concept
2. Write to GBrain as a page with:
   - `type` field (catalyst, author, institution, concept, method)
   - `llm_wiki_link` field with absolute path to wiki page
   - `summary` field
   - `key_papers` count
   - `relations` list
3. **Never** write full wiki content into GBrain
4. **Never** trigger a new wiki page creation from GBrain

**GBrain CLI command**:
```bash
node <gbrain-path>/scripts/add.mjs entity --id "<slug>" --type "<type>" --label "<Name>" --attrs '{"llm_wiki":"<path>","summary":"<summary>"}'
```

### 5. Bulk Backfill (For Existing Source Libraries)

**Trigger**: You have hundreds of source summaries but empty concepts/entities/methods.

**Workflow**:
1. Scan all `wiki/sources/*.md` files
2. Extract frontmatter fields: `authors`, `tags`, `methods`, `catalysts`, `materials`
3. For each unique entity/concept/method:
   - Create the wiki page if it doesn't exist
   - Link all relevant sources
4. Update `wiki/index.md`
5. Sync summaries to GBrain

**Script approach**: Write a Python script that parses frontmatter and generates entity pages. See `scripts/backfill_entities.py`.

### 6. Maintenance

| Frequency | Action | Location |
|-----------|--------|----------|
| Every ingest | Update index.md, log.md, hot.md | LLM-Wiki |
| Every 50 sources | Run wiki-lint (check for dead links, empty pages) | LLM-Wiki |
| Weekly | Promote memory logs to MEMORY.md (preferences only) | OpenClaw Memory |
| Monthly | GBrain dream cycle + knowledge graph review | GBrain |
| Monthly | MEMORY.md review + knowledge migration to wiki | OpenClaw Memory |
| Quarterly | Full wiki overview.md rewrite | LLM-Wiki |

## Templates

### Source Summary Template (`_templates/source.md`)

```markdown
---
title: <Paper Title>
type: source-summary
authors: [<Author1>, <Author2>]
year: <YYYY>
journal: <Journal Name>
doi: <DOI>
tags: [<tag1>, <tag2>]
created: <YYYY-MM-DD>
updated: <YYYY-MM-DD>
---

## 研究背景与问题

## 研究方法

## 核心发现

## 关键数据

## 创新点

## 局限与不足

## 与你研究的关联
```

### Entity Template (`_templates/entity.md`)

```markdown
---
title: <Name>
type: entity
entity_type: author | institution | catalyst | material
created: <YYYY-MM-DD>
updated: <YYYY-MM-DD>
sources: [<source-slugs>]
tags: [<tags>]
---

## Overview
<2-3 sentences>

## Key Papers
- [[../sources/<slug>]] — <note>

## Related Entities
- [[<entity>]] — <relation>

## Notes
```

### Concept Template (`_templates/concept.md`)

```markdown
---
title: <Concept Name>
type: concept
created: <YYYY-MM-DD>
updated: <YYYY-MM-DD>
sources: [<source-slugs>]
tags: [<tags>]
---

## Definition

## Mechanism / Explanation

## Key Evidence
- [[../sources/<slug>]] — <specific finding>

## Related Concepts
- [[<concept>]] — <relation>

## Controversies / Open Questions
```

## Conventions

### File Naming
- Lowercase, hyphen-separated, no spaces
- Remove special characters: `Cu-CeO2-catalyst.md`, `in-situ-drifts.md`
- For non-ASCII titles: use pinyin or English translation + original in frontmatter

### Internal Links
- Source to entity: `[[../entities/<slug>]]`
- Entity to source: `[[../sources/<slug>]]`
- Concept to concept: `[[<slug>]]` (same directory)
- Cross-directory: use relative paths `[[../concepts/<slug>]]`

### YAML Frontmatter
All wiki pages MUST have YAML frontmatter with at minimum:
```yaml
---
title: <display title>
type: source-summary | entity | concept | method | comparison | synthesis | question | gap
created: YYYY-MM-DD
updated: YYYY-MM-DD
---
```

### Confidence Annotations
- `(high confidence)` — multiple sources agree
- `(tentative)` — single source or preliminary data
- `(single-source)` — only one paper supports this
- Mark contradictions: `⚠️ CONTRADICTION: ...`

### Git
- `raw/` and `cache/` are in `.gitignore` (too large, immutable)
- `wiki/`, `_templates/`, `SCHEMA.md`, `AGENTS.md` are tracked
- Commit message format: `wiki: <action> <page>` or `ingest: <source-slug>`

## Anti-Patterns (What NOT to Do)

1. **Do NOT store full knowledge in GBrain** — GBrain is an index, not a library. Keep summaries under 5 sentences.
2. **Do NOT store structured knowledge in OpenClaw MEMORY.md** — Memory is for logs and preferences. Migrate knowledge to wiki.
3. **Do NOT create circular writes** — GBrain → Wiki → GBrain loops must be broken. Wiki is the source of truth.
4. **Do NOT let concepts/entities directories stay empty** — If you have 1000+ sources, you should have hundreds of concept/entity pages.
5. **Do NOT mix raw sources with processed knowledge** — `raw/` is immutable. Processed content goes to `wiki/sources/`.
6. **Do NOT skip index.md updates** — The index is how you (and future you) find things.

## Migration from Flat Reading Workflow

If you currently have:
- A directory of PDFs
- A flat list of reading notes
- No concept/entity extraction

Migration steps:
1. Create the LLM-Wiki directory structure
2. Move existing notes to `wiki/sources/` (one file per source)
3. Add YAML frontmatter to each source summary
4. Run bulk backfill to extract concepts/entities/methods
5. Create `wiki/overview.md` with your current understanding
6. Set up GBrain sync
7. Start using the ingest workflow for new sources

## References

- `references/llm-wiki-schema.md` — Full LLM-Wiki schema specification
- `references/gbrain-integration.md` — GBrain integration protocol and CLI commands
- `references/backfill-guide.md` — Step-by-step bulk backfill guide for existing libraries
- `references/obsidian-setup.md` — Obsidian configuration for visual browsing
