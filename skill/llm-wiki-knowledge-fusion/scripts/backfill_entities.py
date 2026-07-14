#!/usr/bin/env python3
"""
Backfill entities, concepts, and methods from LLM-Wiki source summaries.

Usage:
    python backfill_entities.py --wiki-dir "F:\\xz-wiki-upgraded\\wiki" --dry-run
    python backfill_entities.py --wiki-dir "F:\\xz-wiki-upgraded\\wiki" --batch-size 100
    python backfill_entities.py --wiki-dir "F:\\xz-wiki-upgraded\\wiki" --incremental --since 2026-07-01

Requirements: pyyaml
"""

import argparse
import json
import os
import re
import sys
from datetime import datetime
from pathlib import Path

import yaml


def parse_frontmatter(content: str) -> dict:
    """Extract YAML frontmatter from markdown content."""
    if content.startswith("---"):
        parts = content.split("---", 2)
        if len(parts) >= 3:
            try:
                return yaml.safe_load(parts[1]) or {}
            except yaml.YAMLError:
                return {}
    return {}


def slugify(name: str) -> str:
    """Convert a name to a valid filename slug."""
    # Lowercase
    s = name.lower()
    # Replace special chars with hyphen
    s = re.sub(r'[()\[\]{}\\/:*?"<>|]', '-', s)
    # Replace spaces with hyphen
    s = s.replace(' ', '-')
    # Replace multiple hyphens with single
    s = re.sub(r'-+', '-', s)
    # Remove leading/trailing hyphens
    s = s.strip('-')
    # Remove non-ASCII (or transliterate)
    s = re.sub(r'[^\x00-\x7F]', '', s)
    return s


def load_sources(wiki_dir: Path, since: str = None) -> list:
    """Load all source summaries from wiki/sources/."""
    sources_dir = wiki_dir / "sources"
    sources = []
    
    for md_file in sorted(sources_dir.glob("*.md")):
        content = md_file.read_text(encoding="utf-8")
        fm = parse_frontmatter(content)
        
        if since and fm.get("created"):
            if fm["created"] < since:
                continue
        
        sources.append({
            "file": md_file.name,
            "slug": md_file.stem,
            "frontmatter": fm,
            "content": content
        })
    
    return sources


def extract_entities(sources: list) -> dict:
    """Extract entities, concepts, and methods from sources."""
    entities = {
        "authors": {},
        "institutions": {},
        "catalysts": {},
        "materials": {},
        "methods": {},
        "concepts": {}
    }
    
    for source in sources:
        fm = source["frontmatter"]
        slug = source["slug"]
        
        # Authors
        for author in fm.get("authors", []):
            if author:
                key = slugify(author)
                if key not in entities["authors"]:
                    entities["authors"][key] = {"name": author, "sources": []}
                entities["authors"][key]["sources"].append(slug)
        
        # Institutions (if present in frontmatter)
        for inst in fm.get("institutions", []):
            if inst:
                key = slugify(inst)
                if key not in entities["institutions"]:
                    entities["institutions"][key] = {"name": inst, "sources": []}
                entities["institutions"][key]["sources"].append(slug)
        
        # Catalysts (if present in frontmatter)
        for cat in fm.get("catalysts", []):
            if cat:
                key = slugify(cat)
                if key not in entities["catalysts"]:
                    entities["catalysts"][key] = {"name": cat, "sources": []}
                entities["catalysts"][key]["sources"].append(slug)
        
        # Materials (if present in frontmatter)
        for mat in fm.get("materials", []):
            if mat:
                key = slugify(mat)
                if key not in entities["materials"]:
                    entities["materials"][key] = {"name": mat, "sources": []}
                entities["materials"][key]["sources"].append(slug)
        
        # Methods (if present in frontmatter)
        for method in fm.get("methods", []):
            if method:
                key = slugify(method)
                if key not in entities["methods"]:
                    entities["methods"][key] = {"name": method, "sources": []}
                entities["methods"][key]["sources"].append(slug)
        
        # Tags → concepts
        for tag in fm.get("tags", []):
            if tag and tag.lower() not in ["catalysis", "reaction", "catalyst"]:
                key = slugify(tag)
                if key not in entities["concepts"]:
                    entities["concepts"][key] = {"name": tag, "sources": []}
                entities["concepts"][key]["sources"].append(slug)
    
    return entities


def generate_entity_page(entity_type: str, slug: str, data: dict, wiki_dir: Path) -> str:
    """Generate markdown content for an entity page."""
    name = data["name"]
    sources = sorted(set(data["sources"]))
    today = datetime.now().strftime("%Y-%m-%d")
    
    # Determine target directory and page type
    if entity_type in ["authors", "institutions"]:
        page_type = "entity"
        entity_type_label = "author" if entity_type == "authors" else "institution"
        target_dir = "entities"
    elif entity_type in ["catalysts", "materials"]:
        page_type = "concept"
        entity_type_label = "catalyst" if entity_type == "catalysts" else "material"
        target_dir = "concepts"
    elif entity_type == "methods":
        page_type = "method"
        entity_type_label = "method"
        target_dir = "methods"
    else:  # concepts
        page_type = "concept"
        entity_type_label = "concept"
        target_dir = "concepts"
    
    # Build source links
    source_links = []
    for src in sources[:20]:  # Limit to 20 to avoid huge pages
        source_links.append(f"- [[../sources/{src}]]")
    if len(sources) > 20:
        source_links.append(f"- ... and {len(sources) - 20} more")
    
    content = f"""---
title: {name}
type: {page_type}
entity_type: {entity_type_label}
created: {today}
updated: {today}
sources: {json.dumps(sources[:50])}
tags: []
---

## Overview

<Entity description - auto-generated or manual>

## Key Papers

{chr(10).join(source_links)}

## Related <Entities/Concepts/Methods>

<Auto-linked based on co-occurrence>

## Notes

"""
    return content


def write_entity_pages(entities: dict, wiki_dir: Path, dry_run: bool = False):
    """Write entity pages to wiki directories."""
    counts = {}
    
    for entity_type, items in entities.items():
        if not items:
            continue
        
        # Determine target directory
        if entity_type in ["authors", "institutions"]:
            target_dir = wiki_dir / "entities"
        elif entity_type in ["catalysts", "materials", "concepts"]:
            target_dir = wiki_dir / "concepts"
        elif entity_type == "methods":
            target_dir = wiki_dir / "methods"
        else:
            continue
        
        target_dir.mkdir(parents=True, exist_ok=True)
        counts[entity_type] = 0
        
        for slug, data in items.items():
            if not slug:
                continue
            
            file_path = target_dir / f"{slug}.md"
            
            if file_path.exists():
                # Update existing page
                existing = file_path.read_text(encoding="utf-8")
                existing_fm = parse_frontmatter(existing)
                existing_sources = set(existing_fm.get("sources", []))
                new_sources = set(data["sources"])
                
                if new_sources.issubset(existing_sources):
                    continue  # No new sources
                
                # Merge sources
                all_sources = sorted(existing_sources | new_sources)
                today = datetime.now().strftime("%Y-%m-%d")
                
                # Update frontmatter
                new_fm = existing_fm.copy()
                new_fm["sources"] = all_sources[:50]
                new_fm["updated"] = today
                
                # Rebuild content
                fm_yaml = yaml.dump(new_fm, allow_unicode=True, sort_keys=False)
                body = existing.split("---", 2)[2] if "---" in existing else existing
                new_content = f"---\n{fm_yaml}---{body}"
                
                if not dry_run:
                    file_path.write_text(new_content, encoding="utf-8")
                counts[entity_type] += 1
            else:
                # Create new page
                content = generate_entity_page(entity_type, slug, data, wiki_dir)
                if not dry_run:
                    file_path.write_text(content, encoding="utf-8")
                counts[entity_type] += 1
    
    return counts


def update_index(wiki_dir: Path, entities: dict, dry_run: bool = False):
    """Update wiki/index.md with new entities."""
    index_path = wiki_dir / "index.md"
    
    # Build index content
    lines = ["# Index", "", "> 文献库总索引", ""]
    
    # Sources section
    lines.append("## Sources")
    lines.append("")
    lines.append("| File | Title | Date Added | Tags |")
    lines.append("|------|-------|------------|------|")
    # Sources are too many to list individually; keep existing or use dataview
    lines.append("| See wiki/sources/ | ... | ... | ... |")
    lines.append("")
    
    # Entities section
    if entities.get("authors") or entities.get("institutions"):
        lines.append("## Entities")
        lines.append("")
        lines.append("| File | Name | Type | Sources |")
        lines.append("|------|------|------|---------|")
        
        for slug, data in sorted(entities.get("authors", {}).items()):
            lines.append(f"| [[entities/{slug}]] | {data['name']} | author | {len(data['sources'])} |")
        for slug, data in sorted(entities.get("institutions", {}).items()):
            lines.append(f"| [[entities/{slug}]] | {data['name']} | institution | {len(data['sources'])} |")
        lines.append("")
    
    # Concepts section
    if entities.get("catalysts") or entities.get("materials") or entities.get("concepts"):
        lines.append("## Concepts")
        lines.append("")
        lines.append("| File | Name | Sources |")
        lines.append("|------|------|---------|")
        
        for slug, data in sorted(entities.get("catalysts", {}).items()):
            lines.append(f"| [[concepts/{slug}]] | {data['name']} | {len(data['sources'])} |")
        for slug, data in sorted(entities.get("materials", {}).items()):
            lines.append(f"| [[concepts/{slug}]] | {data['name']} | {len(data['sources'])} |")
        for slug, data in sorted(entities.get("concepts", {}).items()):
            lines.append(f"| [[concepts/{slug}]] | {data['name']} | {len(data['sources'])} |")
        lines.append("")
    
    # Methods section
    if entities.get("methods"):
        lines.append("## Methods")
        lines.append("")
        lines.append("| File | Method | Sources |")
        lines.append("|------|--------|---------|")
        
        for slug, data in sorted(entities.get("methods", {}).items()):
            lines.append(f"| [[methods/{slug}]] | {data['name']} | {len(data['sources'])} |")
        lines.append("")
    
    content = "\n".join(lines)
    
    if not dry_run:
        index_path.write_text(content, encoding="utf-8")
    
    return len(lines)


def main():
    parser = argparse.ArgumentParser(description="Backfill entities from LLM-Wiki sources")
    parser.add_argument("--wiki-dir", required=True, help="Path to wiki/ directory")
    parser.add_argument("--batch-size", type=int, default=100, help="Process in batches")
    parser.add_argument("--dry-run", action="store_true", help="Preview without writing")
    parser.add_argument("--incremental", action="store_true", help="Only process new sources")
    parser.add_argument("--since", help="Process sources created since YYYY-MM-DD")
    
    args = parser.parse_args()
    
    wiki_dir = Path(args.wiki_dir)
    if not wiki_dir.exists():
        print(f"Error: Directory not found: {wiki_dir}")
        sys.exit(1)
    
    sources_dir = wiki_dir / "sources"
    if not sources_dir.exists():
        print(f"Error: No sources/ directory found in {wiki_dir}")
        sys.exit(1)
    
    print(f"Loading sources from {sources_dir}...")
    sources = load_sources(wiki_dir, args.since)
    print(f"Found {len(sources)} sources")
    
    if not sources:
        print("No sources to process.")
        return
    
    print("Extracting entities...")
    entities = extract_entities(sources)
    
    total = sum(len(v) for v in entities.values())
    print(f"Found {total} unique entities:")
    for k, v in entities.items():
        print(f"  {k}: {len(v)}")
    
    if args.dry_run:
        print("\nDRY RUN - no files will be written")
        print("\nSample entities:")
        for entity_type, items in entities.items():
            if items:
                sample = list(items.items())[:3]
                print(f"\n  {entity_type}:")
                for slug, data in sample:
                    print(f"    {slug}: {data['name']} ({len(data['sources'])} sources)")
        return
    
    print("\nWriting entity pages...")
    counts = write_entity_pages(entities, wiki_dir, dry_run=False)
    
    print("\nUpdating index.md...")
    update_index(wiki_dir, entities, dry_run=False)
    
    print("\nDone!")
    print(f"Created/updated pages:")
    for k, v in counts.items():
        print(f"  {k}: {v}")


if __name__ == "__main__":
    main()
