# Royal Gazette Thailand (Ratchakitcha) Sync Tool

Sync tool for downloading Royal Gazette Thailand PDF documents from the [HuggingFace dataset](https://huggingface.co/datasets/open-law-data-thailand/soc-ratchakitcha).

## Requirements

- Node.js 18+ (uses native fetch)

## Usage

```bash
# Download hot PDFs (current months: 2025-12, 2026-01)
node sync-ratchakitcha.js

# Download specific months from pdf/ folder
node sync-ratchakitcha.js 2024-01 2024-02 2024-03

# Download from ZIP archives (for older/archived months)
node sync-ratchakitcha.js --zip 2025-11

# Verify downloads against meta index
node sync-ratchakitcha.js --verify
```

Or using npm scripts:

```bash
npm run sync
npm run verify
```

## Features

- Uses meta JSONL files as source of truth for verification
- Resume support (skips already downloaded files)
- Concurrent downloads (5 parallel by default)
- Progress bar with real-time stats
- Retry logic (3 attempts per file)
- API pagination support for large file lists
- ZIP archive download and extraction for older months

## Output Structure

```
downloads/
├── meta/
│   ├── 2025/
│   │   ├── 2025-11.jsonl
│   │   └── 2025-12.jsonl
│   └── 2026/
│       └── 2026-01.jsonl
├── pdf/
│   ├── 2025/
│   │   ├── 2025-11/
│   │   │   └── *.pdf (extracted from ZIP)
│   │   └── 2025-12/
│   │       └── *.pdf
│   └── 2026/
│       └── 2026-01/
│           └── *.pdf
├── zip/
│   └── 2025/
│       └── 2025-11.zip
└── sync-summary.json
```

## Data Source

Dataset: [open-law-data-thailand/soc-ratchakitcha](https://huggingface.co/datasets/open-law-data-thailand/soc-ratchakitcha)

License: CC-BY-4.0
