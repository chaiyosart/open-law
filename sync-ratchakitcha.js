#!/usr/bin/env node

/**
 * Sync script for downloading Royal Gazette Thailand (Ratchakitcha) dataset
 * from HuggingFace: open-law-data-thailand/soc-ratchakitcha
 *
 * Usage:
 *   node sync-ratchakitcha.js                    # Download hot PDFs (2025-12, 2026-01)
 *   node sync-ratchakitcha.js 2024-01 2024-02    # Download specific months
 *   node sync-ratchakitcha.js --zip 2025-11      # Download from ZIP archive
 *   node sync-ratchakitcha.js --verify           # Verify existing downloads
 */

const fs = require('fs');
const path = require('path');
const { pipeline } = require('stream/promises');
const { execSync } = require('child_process');

// Configuration
const CONFIG = {
  repo: 'open-law-data-thailand/soc-ratchakitcha',
  baseUrl: 'https://huggingface.co',
  outputDir: './downloads',
  concurrency: 5,
  retryAttempts: 3,
  retryDelay: 1000,
  defaultMonths: ['2025-12', '2026-01'], // Hot PDF months
};

// HuggingFace API URLs
const getApiUrl = (path) =>
  `${CONFIG.baseUrl}/api/datasets/${CONFIG.repo}/tree/main/${path}`;
const getDownloadUrl = (path) =>
  `${CONFIG.baseUrl}/datasets/${CONFIG.repo}/resolve/main/${path}`;

// Utility: sleep
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Utility: ensure directory exists
function ensureDir(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

// Utility: format bytes
function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

// Utility: progress bar
function progressBar(current, total, width = 30) {
  const percent = Math.round((current / total) * 100);
  const filled = Math.round((current / total) * width);
  const empty = width - filled;
  return `[${'█'.repeat(filled)}${'░'.repeat(empty)}] ${percent}% (${current}/${total})`;
}

// Fetch with retry
async function fetchWithRetry(url, options = {}, attempts = CONFIG.retryAttempts) {
  for (let i = 0; i < attempts; i++) {
    try {
      const response = await fetch(url, options);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }
      return response;
    } catch (error) {
      if (i === attempts - 1) throw error;
      console.log(`  Retry ${i + 1}/${attempts - 1} for ${path.basename(url)}`);
      await sleep(CONFIG.retryDelay * (i + 1));
    }
  }
}

// List files from HuggingFace API with pagination support
async function listFiles(remotePath) {
  const allFiles = [];
  let cursor = null;
  let pageNum = 1;

  while (true) {
    let url = getApiUrl(remotePath);
    if (cursor) {
      url += `?cursor=${encodeURIComponent(cursor)}`;
    }

    const response = await fetchWithRetry(url);

    // Check for next page cursor in Link header
    const linkHeader = response.headers.get('Link');
    let nextCursor = null;
    if (linkHeader) {
      const match = linkHeader.match(/cursor=([^&>]+)/);
      if (match) {
        nextCursor = decodeURIComponent(match[1]);
      }
    }

    const items = await response.json();
    const files = items.filter(item => item.type === 'file');
    allFiles.push(...files);

    // If we got less than 1000 items or no next cursor, we're done
    if (!nextCursor || items.length < 1000) {
      break;
    }

    cursor = nextCursor;
    pageNum++;
    process.stdout.write(`\r  Fetching file list... page ${pageNum} (${allFiles.length} files so far)`);
  }

  return allFiles;
}

// List directories from HuggingFace API
async function listDirs(remotePath) {
  const url = getApiUrl(remotePath);
  const response = await fetchWithRetry(url);
  const items = await response.json();
  return items.filter(item => item.type === 'directory');
}

// Download a single file
async function downloadFile(remotePath, localPath) {
  // Skip if file exists and has content
  if (fs.existsSync(localPath)) {
    const stats = fs.statSync(localPath);
    if (stats.size > 0) {
      return { status: 'skipped', path: localPath };
    }
  }

  ensureDir(path.dirname(localPath));

  const url = getDownloadUrl(remotePath);
  const response = await fetchWithRetry(url);

  const fileStream = fs.createWriteStream(localPath);
  await pipeline(response.body, fileStream);

  return { status: 'downloaded', path: localPath };
}

// Download meta file for a month (always re-download to check for updates)
async function downloadMeta(yearMonth) {
  const [year] = yearMonth.split('-');
  const remotePath = `meta/${year}/${yearMonth}.jsonl`;
  const localPath = path.join(CONFIG.outputDir, remotePath);

  console.log(`\n📋 Fetching meta: ${yearMonth}.jsonl`);

  ensureDir(path.dirname(localPath));

  try {
    const url = getDownloadUrl(remotePath);
    const response = await fetchWithRetry(url);
    const content = await response.text();

    // Check if content changed
    let status = 'new';
    if (fs.existsSync(localPath)) {
      const existing = fs.readFileSync(localPath, 'utf-8');
      if (existing === content) {
        console.log(`  ✓ No changes`);
        return localPath;
      }
      status = 'updated';
    }

    fs.writeFileSync(localPath, content);
    console.log(`  ✅ ${status === 'updated' ? 'Updated' : 'Downloaded'} (${content.split('\n').filter(l => l.trim()).length} entries)`);
    return localPath;
  } catch (error) {
    if (fs.existsSync(localPath)) {
      console.log(`  ⚠️  Failed to fetch, using cached version`);
      return localPath;
    }
    console.log(`  ⚠️  Meta file not found (may not exist for this month)`);
    return null;
  }
}

// Parse JSONL meta file
function parseMetaFile(filePath) {
  if (!fs.existsSync(filePath)) return [];

  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.trim().split('\n').filter(line => line.trim());

  return lines.map(line => {
    try {
      return JSON.parse(line);
    } catch {
      return null;
    }
  }).filter(Boolean);
}

// Download PDFs for a month with concurrency control
// Uses meta file as source of truth (API has 1000 file pagination limit)
async function downloadPdfs(yearMonth, metaPath) {
  const [year] = yearMonth.split('-');
  const remotePath = `pdf/${year}/${yearMonth}`;
  const localDir = path.join(CONFIG.outputDir, remotePath);

  console.log(`\n📁 Getting PDF list for ${yearMonth}...`);

  let files = [];

  // Use meta file as source of truth (avoids API pagination limit of 1000)
  if (metaPath && fs.existsSync(metaPath)) {
    const meta = parseMetaFile(metaPath);
    files = meta
      .filter(m => m.pdf_file)
      .map(m => ({
        path: `${remotePath}/${m.pdf_file}`,
        name: m.pdf_file,
      }));
    console.log(`  Found ${files.length} PDFs in meta file`);
  } else {
    // Fallback to API (limited to 1000 files)
    try {
      const apiFiles = await listFiles(remotePath);
      files = apiFiles.map(f => ({ path: f.path, name: path.basename(f.path) }));
      console.log(`  Found ${files.length} PDFs from API (may be incomplete if >1000)`);
    } catch (error) {
      console.log(`  ⚠️  No PDF folder found for ${yearMonth} (may be archived in ZIP)`);
      return { downloaded: 0, skipped: 0, failed: 0, files: [] };
    }
  }

  if (files.length === 0) {
    return { downloaded: 0, skipped: 0, failed: 0, files: [] };
  }

  ensureDir(localDir);

  let downloaded = 0;
  let skipped = 0;
  let failed = 0;
  const results = [];

  // Process files with concurrency limit
  const queue = [...files];
  const inProgress = new Set();

  async function processNext() {
    if (queue.length === 0) return;

    const file = queue.shift();
    const fileName = file.name;
    const localPath = path.join(localDir, fileName);

    try {
      const result = await downloadFile(file.path, localPath);
      results.push({ name: fileName, size: file.size, status: result.status });

      if (result.status === 'downloaded') {
        downloaded++;
      } else {
        skipped++;
      }
    } catch (error) {
      failed++;
      results.push({ name: fileName, size: file.size, status: 'failed', error: error.message });
    }

    // Update progress
    const total = files.length;
    const done = downloaded + skipped + failed;
    process.stdout.write(`\r  ${progressBar(done, total)} - ${downloaded} new, ${skipped} skipped, ${failed} failed`);
  }

  // Start concurrent downloads
  while (queue.length > 0 || inProgress.size > 0) {
    while (inProgress.size < CONFIG.concurrency && queue.length > 0) {
      const promise = processNext();
      inProgress.add(promise);
      promise.finally(() => inProgress.delete(promise));
    }

    if (inProgress.size > 0) {
      await Promise.race(inProgress);
    }
  }

  console.log(''); // New line after progress bar

  return { downloaded, skipped, failed, files: results };
}

// Download and extract ZIP for a month
async function downloadAndExtractZip(yearMonth) {
  const [year] = yearMonth.split('-');
  const remotePath = `zip/${year}/${yearMonth}.zip`;
  const zipDir = path.join(CONFIG.outputDir, 'zip', year);
  const zipPath = path.join(zipDir, `${yearMonth}.zip`);
  const pdfDir = path.join(CONFIG.outputDir, `pdf/${year}/${yearMonth}`);

  console.log(`\n📦 Processing ZIP: ${yearMonth}.zip`);

  // Check if already extracted
  if (fs.existsSync(pdfDir)) {
    const existingFiles = fs.readdirSync(pdfDir).filter(f => f.endsWith('.pdf'));
    if (existingFiles.length > 0) {
      console.log(`  ✓ Already extracted (${existingFiles.length} PDFs in ${pdfDir})`);
      return { status: 'skipped', extracted: existingFiles.length };
    }
  }

  ensureDir(zipDir);
  ensureDir(pdfDir);

  // Download ZIP if not exists or empty
  let needsDownload = true;
  if (fs.existsSync(zipPath)) {
    const stats = fs.statSync(zipPath);
    if (stats.size > 0) {
      console.log(`  ✓ ZIP already downloaded (${formatBytes(stats.size)})`);
      needsDownload = false;
    }
  }

  if (needsDownload) {
    console.log(`  ⬇️  Downloading ZIP...`);
    const url = getDownloadUrl(remotePath);

    // Stream download with progress
    const response = await fetchWithRetry(url);
    const contentLength = response.headers.get('content-length');
    const totalBytes = contentLength ? parseInt(contentLength, 10) : 0;

    let downloadedBytes = 0;
    const fileStream = fs.createWriteStream(zipPath);

    // Use a transform to track progress
    const reader = response.body.getReader();

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      fileStream.write(Buffer.from(value));
      downloadedBytes += value.length;

      if (totalBytes > 0) {
        const percent = Math.round((downloadedBytes / totalBytes) * 100);
        process.stdout.write(`\r  ⬇️  Downloading: ${formatBytes(downloadedBytes)} / ${formatBytes(totalBytes)} (${percent}%)`);
      } else {
        process.stdout.write(`\r  ⬇️  Downloading: ${formatBytes(downloadedBytes)}`);
      }
    }

    fileStream.end();
    await new Promise(resolve => fileStream.on('finish', resolve));
    console.log(`\n  ✅ Downloaded: ${formatBytes(downloadedBytes)}`);
  }

  // Extract ZIP
  console.log(`  📂 Extracting to ${pdfDir}...`);

  try {
    // Use unzip command (available on macOS/Linux)
    // -j: junk paths (flatten directory structure)
    // -o: overwrite without prompting
    // Pattern matches PDFs inside the month folder
    execSync(`unzip -j -o "${zipPath}" "${yearMonth}/*.pdf" -d "${pdfDir}"`, {
      stdio: ['pipe', 'pipe', 'pipe'],
      maxBuffer: 10 * 1024 * 1024, // 10MB buffer for output
    });
  } catch (error) {
    // unzip returns exit code 1 for warnings (which we can ignore)
    // Only fail on actual errors (exit code > 1)
    if (error.status > 1) {
      console.error(`  ❌ Extraction failed: ${error.message}`);
      return { status: 'failed', extracted: 0, error: error.message };
    }
  }

  const extractedFiles = fs.readdirSync(pdfDir).filter(f => f.endsWith('.pdf'));
  console.log(`  ✅ Extracted ${extractedFiles.length} PDF files`);

  return { status: 'extracted', extracted: extractedFiles.length };
}

// Verify downloads against meta
function verifyDownloads(yearMonth, metaPath) {
  const [year] = yearMonth.split('-');
  const pdfDir = path.join(CONFIG.outputDir, `pdf/${year}/${yearMonth}`);

  console.log(`\n🔍 Verifying ${yearMonth}...`);

  if (!fs.existsSync(pdfDir)) {
    console.log(`  ⚠️  PDF directory not found`);
    return { expected: 0, found: 0, missing: [] };
  }

  const downloadedFiles = new Set(fs.readdirSync(pdfDir));

  // If we have meta, use it for verification
  if (metaPath && fs.existsSync(metaPath)) {
    const meta = parseMetaFile(metaPath);
    const expectedFiles = meta.map(m => m.pdf_file).filter(Boolean);

    const missing = expectedFiles.filter(f => !downloadedFiles.has(f));
    const extra = [...downloadedFiles].filter(f => !expectedFiles.includes(f));

    console.log(`  Expected: ${expectedFiles.length} files (from meta)`);
    console.log(`  Found: ${downloadedFiles.size} files`);

    if (missing.length > 0) {
      console.log(`  ❌ Missing: ${missing.length} files`);
      missing.slice(0, 5).forEach(f => console.log(`     - ${f}`));
      if (missing.length > 5) console.log(`     ... and ${missing.length - 5} more`);
    }

    if (extra.length > 0) {
      console.log(`  ➕ Extra files (not in meta): ${extra.length}`);
    }

    return { expected: expectedFiles.length, found: downloadedFiles.size, missing };
  }

  // No meta file, just count what we have
  console.log(`  Found: ${downloadedFiles.size} files (no meta to verify against)`);
  return { expected: null, found: downloadedFiles.size, missing: [] };
}

// Calculate total size of downloaded files
function calculateDownloadSize(yearMonth) {
  const [year] = yearMonth.split('-');
  const pdfDir = path.join(CONFIG.outputDir, `pdf/${year}/${yearMonth}`);

  if (!fs.existsSync(pdfDir)) return 0;

  let totalSize = 0;
  const files = fs.readdirSync(pdfDir);

  for (const file of files) {
    const stats = fs.statSync(path.join(pdfDir, file));
    totalSize += stats.size;
  }

  return totalSize;
}

// Main sync function
async function sync(months) {
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('  Royal Gazette Thailand (Ratchakitcha) Dataset Sync');
  console.log('  Repository: open-law-data-thailand/soc-ratchakitcha');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log(`\nTarget months: ${months.join(', ')}`);
  console.log(`Output directory: ${path.resolve(CONFIG.outputDir)}`);

  const summary = {
    months: [],
    totalDownloaded: 0,
    totalSkipped: 0,
    totalFailed: 0,
    totalSize: 0,
  };

  for (const yearMonth of months) {
    console.log(`\n${'─'.repeat(60)}`);
    console.log(`📅 Processing: ${yearMonth}`);
    console.log('─'.repeat(60));

    // Download meta file first (used as source of truth for PDF list)
    const metaPath = await downloadMeta(yearMonth);

    // Download PDFs using meta as source
    const result = await downloadPdfs(yearMonth, metaPath);

    // Verify
    const verification = verifyDownloads(yearMonth, metaPath);

    // Calculate size
    const size = calculateDownloadSize(yearMonth);

    summary.months.push({
      month: yearMonth,
      downloaded: result.downloaded,
      skipped: result.skipped,
      failed: result.failed,
      total: verification.found,
      size,
    });

    summary.totalDownloaded += result.downloaded;
    summary.totalSkipped += result.skipped;
    summary.totalFailed += result.failed;
    summary.totalSize += size;
  }

  // Print summary
  console.log(`\n${'═'.repeat(60)}`);
  console.log('  SYNC COMPLETE');
  console.log('═'.repeat(60));

  console.log('\n📊 Summary by month:');
  for (const m of summary.months) {
    console.log(`  ${m.month}: ${m.total} files (${formatBytes(m.size)})`);
    console.log(`    └─ ${m.downloaded} downloaded, ${m.skipped} skipped, ${m.failed} failed`);
  }

  console.log(`\n📈 Totals:`);
  console.log(`  Files: ${summary.months.reduce((a, m) => a + m.total, 0)}`);
  console.log(`  Size: ${formatBytes(summary.totalSize)}`);
  console.log(`  Downloaded: ${summary.totalDownloaded}`);
  console.log(`  Skipped: ${summary.totalSkipped}`);
  console.log(`  Failed: ${summary.totalFailed}`);

  // Save summary to file
  const summaryPath = path.join(CONFIG.outputDir, 'sync-summary.json');
  ensureDir(CONFIG.outputDir);
  fs.writeFileSync(summaryPath, JSON.stringify({
    timestamp: new Date().toISOString(),
    ...summary,
  }, null, 2));
  console.log(`\n💾 Summary saved to: ${summaryPath}`);

  return summary;
}

// Verify only mode
async function verifyOnly(months) {
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('  Verification Mode');
  console.log('═══════════════════════════════════════════════════════════════');

  for (const yearMonth of months) {
    const [year] = yearMonth.split('-');
    const metaPath = path.join(CONFIG.outputDir, `meta/${year}/${yearMonth}.jsonl`);
    verifyDownloads(yearMonth, metaPath);
  }
}

// Sync from ZIP archives
async function syncFromZip(months) {
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('  Royal Gazette Thailand (Ratchakitcha) Dataset Sync');
  console.log('  Repository: open-law-data-thailand/soc-ratchakitcha');
  console.log('  Mode: ZIP Archive');
  console.log('═══════════════════════════════════════════════════════════════');
  console.log(`\nTarget months: ${months.join(', ')}`);
  console.log(`Output directory: ${path.resolve(CONFIG.outputDir)}`);

  const summary = {
    months: [],
    totalExtracted: 0,
    totalSkipped: 0,
    totalFailed: 0,
    totalSize: 0,
  };

  for (const yearMonth of months) {
    console.log(`\n${'─'.repeat(60)}`);
    console.log(`📅 Processing: ${yearMonth}`);
    console.log('─'.repeat(60));

    // Download meta file first
    const metaPath = await downloadMeta(yearMonth);

    // Download and extract ZIP
    const result = await downloadAndExtractZip(yearMonth);

    // Verify against meta
    const verification = verifyDownloads(yearMonth, metaPath);

    // Calculate size
    const size = calculateDownloadSize(yearMonth);

    summary.months.push({
      month: yearMonth,
      extracted: result.extracted || 0,
      status: result.status,
      total: verification.found,
      size,
    });

    if (result.status === 'extracted') {
      summary.totalExtracted += result.extracted;
    } else if (result.status === 'skipped') {
      summary.totalSkipped += result.extracted;
    } else {
      summary.totalFailed++;
    }
    summary.totalSize += size;
  }

  // Print summary
  console.log(`\n${'═'.repeat(60)}`);
  console.log('  SYNC COMPLETE');
  console.log('═'.repeat(60));

  console.log('\n📊 Summary by month:');
  for (const m of summary.months) {
    console.log(`  ${m.month}: ${m.total} files (${formatBytes(m.size)}) - ${m.status}`);
  }

  console.log(`\n📈 Totals:`);
  console.log(`  Files: ${summary.months.reduce((a, m) => a + m.total, 0)}`);
  console.log(`  Size: ${formatBytes(summary.totalSize)}`);

  // Save summary to file
  const summaryPath = path.join(CONFIG.outputDir, 'sync-summary.json');
  ensureDir(CONFIG.outputDir);
  fs.writeFileSync(summaryPath, JSON.stringify({
    timestamp: new Date().toISOString(),
    mode: 'zip',
    ...summary,
  }, null, 2));
  console.log(`\n💾 Summary saved to: ${summaryPath}`);

  return summary;
}

// CLI
async function main() {
  const args = process.argv.slice(2);

  if (args.includes('--help') || args.includes('-h')) {
    console.log(`
Usage: node sync-ratchakitcha.js [options] [months...]

Options:
  --zip       Download from ZIP archives (for older months)
  --verify    Verify existing downloads only
  --help      Show this help

Examples:
  node sync-ratchakitcha.js                    # Download hot PDFs (2025-12, 2026-01)
  node sync-ratchakitcha.js 2024-01 2024-02    # Download specific months from pdf/
  node sync-ratchakitcha.js --zip 2025-11      # Download from ZIP archive
  node sync-ratchakitcha.js --verify           # Verify existing downloads
`);
    process.exit(0);
  }

  const verifyMode = args.includes('--verify');
  const zipMode = args.includes('--zip');
  const months = args.filter(a => !a.startsWith('--'));
  const targetMonths = months.length > 0 ? months : CONFIG.defaultMonths;

  // Validate month format
  for (const m of targetMonths) {
    if (!/^\d{4}-\d{2}$/.test(m)) {
      console.error(`Invalid month format: ${m} (expected YYYY-MM)`);
      process.exit(1);
    }
  }

  try {
    if (verifyMode) {
      await verifyOnly(targetMonths);
    } else if (zipMode) {
      await syncFromZip(targetMonths);
    } else {
      await sync(targetMonths);
    }
  } catch (error) {
    console.error('\n❌ Error:', error.message);
    process.exit(1);
  }
}

main();
