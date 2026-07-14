# Obsidian Setup for LLM-Wiki Visual Browsing

## Why Obsidian

Obsidian provides:
- Graph view of all wiki pages and their relationships
- Backlinks panel (see what links to the current page)
- Local search with instant results
- Customizable CSS for readability
- Plugins for dataview, templater, etc.

## Setup Steps

### 1. Install Obsidian

Download from https://obsidian.md/ and install.

### 2. Open Vault

1. Launch Obsidian
2. Click "Open folder as vault"
3. Select your LLM-Wiki root directory (e.g., `F:\xz-wiki-upgraded`)

### 3. Configure Obsidian

#### Settings → Files and Links

- **New link format**: `Relative path to file`
- **Use [[Wikilinks]]**: ✅ Enabled
- **Automatically update internal links**: ✅ Enabled

#### Settings → Appearance

- **Font size**: 16px (recommended for readability)
- **Line width**: 80% (recommended for long text)

### 4. Essential Plugins

Enable these core plugins (Settings → Core plugins):
- **Graph view** — visualize page relationships
- **Backlinks** — see incoming links
- **Outgoing links** — see outgoing links
- **Search** — full-text search
- **Quick switcher** — fast page navigation

### 5. Recommended Community Plugins

Install via Settings → Community plugins → Browse:

#### Dataview

Query your wiki like a database:

```dataview
TABLE title, authors, year, tags
FROM "wiki/sources"
SORT year DESC
```

```dataview
TABLE entity_type, sources
FROM "wiki/entities"
SORT entity_type
```

#### Templater

Auto-insert templates when creating new pages:

1. Install Templater
2. Set template folder to `_templates/`
3. Configure hotkeys for quick template insertion

#### Tag Wrangler

Manage tags across all pages:
- Rename tags globally
- See tag usage counts
- Merge similar tags

### 6. Graph View Configuration

Open Graph view (left sidebar icon):

- **Color groups**:
  - `path:wiki/sources` → Blue
  - `path:wiki/concepts` → Green
  - `path:wiki/entities` → Red
  - `path:wiki/methods` → Yellow
  - `path:wiki/comparisons` → Purple
  - `path:wiki/synthesis` → Orange

- **Filters**:
  - Exclude `raw/` directory
  - Exclude `cache/` directory
  - Exclude `progress/` directory

- **Display**:
  - Show arrows (directional links)
  - Node size by number of links
  - Text threshold: 3 (show labels for well-connected nodes)

### 7. Custom CSS (Optional)

Create `.obsidian/snippets/wiki.css`:

```css
/* Highlight confidence annotations */
.markdown-preview-view .cm-highlight {
  background-color: #fff3cd;
  padding: 2px 4px;
  border-radius: 3px;
}

/* Style for contradiction markers */
.markdown-preview-view .cm-contradiction {
  background-color: #f8d7da;
  color: #721c24;
  padding: 2px 4px;
  border-radius: 3px;
}

/* Better table styling for comparisons */
.markdown-preview-view table {
  width: 100%;
  border-collapse: collapse;
}

.markdown-preview-view th {
  background-color: #f0f0f0;
  font-weight: bold;
}

.markdown-preview-view td, .markdown-preview-view th {
  border: 1px solid #ddd;
  padding: 8px;
}
```

Enable in Settings → Appearance → CSS snippets.

### 8. Workspace Layout

Recommended layout:
- **Left sidebar**: File explorer + Search
- **Right sidebar**: Backlinks + Outgoing links + Tag pane
- **Main area**: Note content + Graph view (split)

Save as a workspace: Workspaces → Save current layout.

### 9. Daily Workflow

1. **Reading a source**: Open `wiki/sources/<slug>.md`, read summary, click links to related concepts/entities
2. **Exploring a concept**: Open `wiki/concepts/<slug>.md`, see all linked sources and related concepts in backlinks
3. **Finding connections**: Use Graph view to see which sources connect to which concepts
4. **Searching**: Use Search for keywords, or Dataview for structured queries
5. **Updating**: Edit pages, links auto-update

### 10. Mobile Sync (Optional)

For mobile access:
- Use Obsidian Sync (paid) or
- Use Git + Working Copy (iOS) or GitJournal (Android) or
- Use Syncthing (free, self-hosted)

## Tips

- **Use aliases**: In frontmatter, add `aliases: ["alt name", "another name"]` for searchability
- **Pin important pages**: Right-click → Pin for quick access
- **Use bookmarks**: Star frequently accessed pages
- **Graph filters**: Save different graph views for different contexts (e.g., "catalysts only", "methods only")
- **Daily notes**: Use Obsidian's daily notes for session logs, but migrate structured knowledge to wiki
