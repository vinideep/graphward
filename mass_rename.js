const fs = require('fs');
const path = require('path');

const dir = process.cwd();

function walk(dir) {
    let results = [];
    const list = fs.readdirSync(dir);
    list.forEach(function(file) {
        file = path.join(dir, file);
        const stat = fs.statSync(file);
        if (stat && stat.isDirectory()) {
            if (!file.includes('node_modules') && !file.includes('.git') && !file.includes('dist')) {
                results = results.concat(walk(file));
            }
        } else {
            if (!file.includes('node_modules') && !file.includes('.git') && !file.includes('dist')) {
                const ext = path.extname(file);
                if (['.ts', '.md', '.json', '.js', '.mdc', '.yaml', '.yml', '.sh', '.mjs'].includes(ext)) {
                    results.push(file);
                }
            }
        }
    });
    return results;
}

const files = walk(dir);

files.forEach(file => {
    let content = fs.readFileSync(file, 'utf8');
    let original = content;

    content = content.replace(/npx gw/g, 'npx gw');
    content = content.replace(/graphward-blueprint/g, 'graphward-blueprint');
    content = content.replace(/graphward-impact/g, 'graphward-impact');
    content = content.replace(/graphward-skill/g, 'graphward-skill');
    content = content.replace(/graphward-OS/g, 'graphward-OS');
    content = content.replace(/\.graphward/g, '.graphward');
    content = content.replace(/graphward/g, 'graphward');
    content = content.replace(/ei\.config\.json/g, 'gw.config.json');
    content = content.replace(/GW_CONFIG_PATH/g, 'GW_CONFIG_PATH');
    content = content.replace(/GW_CONFIG/g, 'GW_CONFIG');
    content = content.replace(/GraphWard/g, 'GraphWard');

    if (file.endsWith('.md')) {
        content = content.replace(/EI /g, 'GraphWard ');
        content = content.replace(/"EI"/g, '"GraphWard"');
    }

    if (content !== original) {
        fs.writeFileSync(file, content, 'utf8');
        console.log(`Updated ${file}`);
    }
});
