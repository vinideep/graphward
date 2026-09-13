import fs from 'node:fs/promises';
import path from 'node:path';

async function replaceInFiles(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'dist') continue;
    
    const fullPath = path.join(dir, entry.name);
    
    if (entry.isDirectory()) {
      await replaceInFiles(fullPath);
    } else if (entry.name.endsWith('.ts') || entry.name.endsWith('.mjs') || entry.name.endsWith('.md')) {
      if (fullPath.includes('src/verify/index.ts') || fullPath.includes('script-rename.mjs')) continue;
      
      let content = await fs.readFile(fullPath, 'utf8');
      const original = content;
      
      // We want to replace receipt -> record, Receipt -> VerificationRecord, receipts -> records
      // But we have to be careful with words like 'receipts.json' which we'll handle manually.
      
      // Let's do a smart replace.
      // Receipts -> Records
      // receipts -> records
      // Receipt -> VerificationRecord
      // receipt -> record
      
      content = content.replace(/\breceipts\.json\b/g, 'verification-records.json');
      content = content.replace(/\breadReceipts\b/g, 'readRecords');
      content = content.replace(/\bwriteReceipt\b/g, 'writeRecord');
      content = content.replace(/\bReceipts\b/g, 'Records');
      content = content.replace(/\breceipts\b/g, 'records');
      content = content.replace(/\bReceipt\b/g, 'VerificationRecord');
      content = content.replace(/\breceipt\b/g, 'record');
      
      if (content !== original) {
        console.log(`Updated ${fullPath}`);
        await fs.writeFile(fullPath, content, 'utf8');
      }
    }
  }
}

replaceInFiles(process.cwd()).catch(console.error);
