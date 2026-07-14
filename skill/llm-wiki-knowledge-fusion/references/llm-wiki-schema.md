# LLM-Wiki Schema Specification

## Complete Directory Structure

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
    ├── questions/         # Research questions (active inquiries)
    ├── domains/           # Domain overviews (sub-field summaries)
    ├── papers/            # Paper-specific deep dives (optional)
    └── meta/              # Meta-information (schema evolution, conventions)
```

## Page Types and Frontmatter

### source-summary

```yaml
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
```

Sections: 研究背景与问题, 研究方法, 核心发现, 关键数据, 创新点, 局限与不足, 与你研究的关联

### entity

```yaml
---
title: <Name>
type: entity
entity_type: author | institution | catalyst | material | organization
created: <YYYY-MM-DD>
updated: <YYYY-MM-DD>
sources: [<source-slugs>]
tags: [<tags>]
---
```

Sections: Overview, Key Papers, Related Entities, Notes

### concept

```yaml
---
title: <Concept Name>
type: concept
created: <YYYY-MM-DD>
updated: <YYYY-MM-DD>
sources: [<source-slugs>]
tags: [<tags>]
---
```

Sections: Definition, Mechanism/Explanation, Key Evidence, Related Concepts, Controversies/Open Questions

### method

```yaml
---
title: <Method Name>
type: method
created: <YYYY-MM-DD>
updated: <YYYY-MM-DD>
sources: [<source-slugs>]
tags: [<tags>]
---
```

Sections: Description, Procedure, Key Parameters, Advantages/Limitations, Related Methods

### comparison

```yaml
---
title: <Comparison Topic>
type: comparison
sources: [<source-slugs>]
created: <YYYY-MM-DD>
updated: <YYYY-MM-DD>
---
```

Sections: Comparison Table, Analysis, Conclusion

### synthesis

```yaml
---
title: <Synthesis Topic>
type: synthesis
sources: [<source-slugs>]
created: <YYYY-MM-DD>
updated: <YYYY-MM-DD>
---
```

Sections: Key Findings, Patterns, Open Questions, Future Directions

### question

```yaml
---
title: <Research Question>
type: question
status: open | partially-answered | answered
sources: [<source-slugs>]
created: <YYYY-MM-DD>
updated: <YYYY-MM-DD>
---
```

Sections: Background, Current Evidence, Gaps, Next Steps

### gap

```yaml
---
title: <Gap Description>
type: gap
severity: high | medium | low
sources: [<source-slugs>]
created: <YYYY-MM-DD>
updated: <YYYY-MM-DD>
---
```

Sections: Description, Why It Matters, Potential Approaches

## File Naming Conventions

- Lowercase, hyphen-separated, no spaces
- Remove special characters: `()`, `[]`, `{}`, `/`, `\`, `:`, `*`, `?`, `"`, `<`, `>`, `|`
- For non-ASCII titles: use pinyin or English translation + original in frontmatter title field
- Examples:
  - `Cu-CeO2-catalyst.md` (not `Cu/CeO₂ catalyst.md`)
  - `in-situ-drifts.md` (not `in situ DRIFTS.md`)
  - `water-gas-shift.md` (not `Water-Gas Shift.md`)

## Link Conventions

### Wikilink Syntax (Obsidian-compatible)

- Same directory: `[[slug]]` or `[[slug|Display Text]]`
- Parent directory: `[[../sources/slug]]`
- Sibling directory: `[[../concepts/slug]]`
- Absolute within wiki: `[[wiki/concepts/slug]]`

### Link Types

- Source to author: `[[../entities/author-name]]`
- Source to concept: `[[../concepts/concept-name]]`
- Source to method: `[[../methods/method-name]]`
- Entity to source: `[[../sources/source-slug]]`
- Concept to concept: `[[related-concept]]` (same directory) or `[[../concepts/other-concept]]`
- Comparison to sources: `[[../sources/source-slug]]` in comparison table

## Index.md Format

```markdown
# Index

> 文献库总索引

## Sources

| File | Title | Date Added | Tags |
|------|-------|------------|------|
| [[sources/slug-1]] | Title 1 | 2026-07-01 | [tag1, tag2] |
| [[sources/slug-2]] | Title 2 | 2026-07-02 | [tag3] |

## Entities

| File | Name | Type | Sources |
|------|------|------|---------|
| [[entities/author-1]] | Author 1 | author | 15 |
| [[entities/catalyst-1]] | Cu-CeO2 | catalyst | 42 |

## Concepts

| File | Name | Sources |
|------|------|---------|
| [[concepts/concept-1]] | Mechanism 1 | 8 |

## Methods

| File | Method | Sources |
|------|--------|---------|
| [[methods/method-1]] | DRIFTS | 23 |

## Comparisons

| File | Topic | Sources |
|------|-------|---------|
| [[comparisons/comparison-1]] | Topic 1 | 5 |

## Synthesis

| File | Topic | Sources |
|------|-------|---------|
| [[synthesis/synthesis-1]] | Topic 1 | 12 |
```

## Log.md Format

```markdown
# Log

## 2026-07-14

- [10:30] Ingested 3 sources: [[sources/slug-1]], [[sources/slug-2]], [[sources/slug-3]]
- [11:15] Created concept: [[concepts/new-concept]]
- [14:00] Updated comparison: [[comparisons/existing-comparison]]

## 2026-07-13

- [09:00] Bulk backfill: extracted 47 entities from 200 sources
```

## Hot.md Format

```markdown
# Hot Topics

> Recently active topics (auto-updated after each ingest)

## Active Concepts
- [[concepts/concept-1]] — 3 new sources this week
- [[concepts/concept-2]] — 2 new sources this week

## Active Entities
- [[entities/entity-1]] — 5 new papers

## Recent Questions
- [[questions/question-1]] — partially answered
```

## .manifest.json Format

```json
{
  "version": 1,
  "sources": {
    "slug-1": {
      "sha256": "abc123...",
      "file": "raw/source-1.pdf",
      "size": 1234567,
      "added": "2026-07-01T10:00:00Z"
    }
  }
}
```

## .gitignore

```
raw/
raw1/
raw2/
raw4/
cache/
progress/
.obsidian/workspace.json
*.tmp
```

## Confidence Annotations

- `(high confidence)` — multiple sources agree, established consensus
- `(tentative)` — single source or preliminary data, needs verification
- `(single-source)` — only one paper supports this claim
- `⚠️ CONTRADICTION: <description>` — conflicting evidence between sources

## Git Commit Conventions

- `wiki: add source <slug>` — new source summary
- `wiki: update concept <slug>` — concept page updated
- `wiki: add entity <slug>` — new entity page
- `ingest: <slug>` — source ingestion completed
- `sync: gbrain <count>` — GBrain sync completed
- `backfill: <count> entities from <count> sources` — bulk backfill
- `lint: fix <count> dead links` — maintenance
