#!/usr/bin/env python3
"""
Sync LLM-Wiki entities/concepts/methods to GBrain.

Usage:
    python sync_to_gbrain.py --wiki-dir "F:\\xz-wiki-upgraded\\wiki" --gbrain-dir "C:\\Users\\<user>\\gbrain"
    python sync_to_gbrain.py --wiki-dir "F:\\xz-wiki-upgraded\\wiki" --dry-run

Requirements: pyyaml
"""

import argparse
import json
import os
import subprocess
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


def generate_summary(content: str, max_sentences: int = 5) -> str:
    """Generate a brief summary from page content."""
    # Simple extraction: take first few sentences after frontmatter
    body = content.split("---", 2)[2] if "---" in content else content
    
    # Find sentences (naive approach)
    sentences = []
    for line in body.split("\n"):
        line = line.strip()
        if line and not line.startswith("#") and not line.startswith("-") and not line.startswith("|"):
            # Split by sentence endings
            parts = line.replace(". ", ".\n").split("\n")
            for part in parts:
                part = part.strip()
                if part and len(part) > 20:
                    sentences.append(part)
                    if len(sentences) >= max_sentences:
                        break
        if len(sentences) >= max_sentences:
            break
    
    return " ".join(sentences)[:500]


def gbrain_add_entity(gbrain_dir: Path, slug: str, entity_type: str, label: str, attrs: dict, dry_run: bool = False):
    """Add or update an entity in GBrain."""
    attrs_json = json.dumps(attrs, ensure_ascii=False)
    
    cmd = [
        "node", str(gbrain_dir / "scripts" / "add.mjs"),
        "entity",
        "--id", slug,
        "--type", entity_type,
        "--label", label,
        "--attrs", attrs_json
    ]
    
    if dry_run:
        print(f"  [DRY] Would run: {' '.join(cmd[:10])}...")
        return True
    
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
        if result.returncode == 0:
            print(f"  ✓ Added/updated: {label} ({slug})")
            return True
        else:
            print(f"  ✗ Failed: {label} - {result.stderr[:200]}")
            return False
    except subprocess.TimeoutExpired:
        print(f"  ✗ Timeout: {label}")
        return False
    except FileNotFoundError:
        print(f"  ✗ Node not found. Is GBrain installed?")
        return False


def sync_entities(wiki_dir: Path, gbrain_dir: Path, dry_run: bool = False):
    """Sync all entity/concept/method pages to GBrain."""
    synced = 0
    failed = 0
    skipped = 0
    
    # Sync entities (authors, institutions)
    entities_dir = wiki_dir / "entities"
    if entities_dir.exists():
        print(f"\nSyncing entities from {entities_dir}...")
        for md_file in entities_dir.glob("*.md"):
            content = md_file.read_text(encoding="utf-8")
            fm = parse_frontmatter(content)
            
            slug = md_file.stem
            label = fm.get("title", slug)
            entity_type = fm.get("entity_type", "entity")
            sources = fm.get("sources", [])
            
            summary = generate_summary(content, 3)
            wiki_path = str(md_file.resolve())
            
            attrs = {
                "llm_wiki": wiki_path,
                "summary": summary,
                "key_papers": len(sources),
                "last_updated": datetime.now().strftime("%Y-%m-%d")
            }
            
            if gbrain_add_entity(gbrain_dir, slug, entity_type, label, attrs, dry_run):
                synced += 1
            else:
                failed += 1
    
    # Sync concepts (catalysts, materials, concepts)
    concepts_dir = wiki_dir / "concepts"
    if concepts_dir.exists():
        print(f"\nSyncing concepts from {concepts_dir}...")
        for md_file in concepts_dir.glob("*.md"):
            content = md_file.read_text(encoding="utf-8")
            fm = parse_frontmatter(content)
            
            slug = md_file.stem
            label = fm.get("title", slug)
            entity_type = fm.get("entity_type", "concept")
            sources = fm.get("sources", [])
            
            summary = generate_summary(content, 3)
            wiki_path = str(md_file.resolve())
            
            attrs = {
                "llm_wiki": wiki_path,
                "summary": summary,
                "key_papers": len(sources),
                "last_updated": datetime.now().strftime("%Y-%m-%d")
            }
            
            if gbrain_add_entity(gbrain_dir, slug, entity_type, label, attrs, dry_run):
                synced += 1
            else:
                failed += 1
    
    # Sync methods
    methods_dir = wiki_dir / "methods"
    if methods_dir.exists():
        print(f"\nSyncing methods from {methods_dir}...")
        for md_file in methods_dir.glob("*.md"):
            content = md_file.read_text(encoding="utf-8")
            fm = parse_frontmatter(content)
            
            slug = md_file.stem
            label = fm.get("title", slug)
            sources = fm.get("sources", [])
            
            summary = generate_summary(content, 3)
            wiki_path = str(md_file.resolve())
            
            attrs = {
                "llm_wiki": wiki_path,
                "summary": summary,
                "key_papers": len(sources),
                "last_updated": datetime.now().strftime("%Y-%m-%d")
            }
            
            if gbrain_add_entity(gbrain_dir, slug, "method", label, attrs, dry_run):
                synced += 1
            else:
                failed += 1
    
    print(f"\n{'='*50}")
    print(f"Sync complete: {synced} synced, {failed} failed, {skipped} skipped")
    return synced, failed, skipped


def main():
    parser = argparse.ArgumentParser(description="Sync LLM-Wiki to GBrain")
    parser.add_argument("--wiki-dir", required=True, help="Path to wiki/ directory")
    parser.add_argument("--gbrain-dir", default=os.path.expanduser("~/gbrain"), help="Path to GBrain directory")
    parser.add_argument("--dry-run", action="store_true", help="Preview without writing")
    
    args = parser.parse_args()
    
    wiki_dir = Path(args.wiki_dir)
    gbrain_dir = Path(args.gbrain_dir)
    
    if not wiki_dir.exists():
        print(f"Error: Wiki directory not found: {wiki_dir}")
        sys.exit(1)
    
    if not gbrain_dir.exists():
        print(f"Error: GBrain directory not found: {gbrain_dir}")
        print("Please install GBrain or specify correct path with --gbrain-dir")
        sys.exit(1)
    
    print(f"Wiki directory: {wiki_dir}")
    print(f"GBrain directory: {gbrain_dir}")
    print(f"Dry run: {args.dry_run}")
    
    sync_entities(wiki_dir, gbrain_dir, args.dry_run)


if __name__ == "__main__":
    main()
