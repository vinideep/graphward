const fs = require('fs');
const path = require('path');

const dir = process.cwd();

function walkFiles(dir) {
    let results = [];
    const list = fs.readdirSync(dir);
    list.forEach(function(file) {
        file = path.join(dir, file);
        const stat = fs.statSync(file);
        if (stat && stat.isDirectory()) {
            if (!file.includes('node_modules') && !file.includes('.git') && !file.includes('dist')) {
                results = results.concat(walkFiles(file));
            }
        } else {
            if (!file.includes('node_modules') && !file.includes('.git') && !file.includes('dist')) {
                results.push(file);
            }
        }
    });
    return results;
}

const files = walkFiles(dir);

const commands = ['hook', 'verify', 'freshness', 'git-analysis', 'map', 'user-profile', 'skill', 'gate', 'context', 'claims', 'sync'];

files.forEach(file => {
    if (['.ts', '.md', '.json', '.js', '.mjs', '.yaml', '.yml', '.mdc', '.sh'].includes(path.extname(file))) {
        let content = fs.readFileSync(file, 'utf8');
        let original = content;

        commands.forEach(cmd => {
            content = content.replace(new RegExp(`graphward ${cmd}`, 'g'), `gw ${cmd}`);
            content = content.replace(new RegExp(`\/graphward ${cmd}`, 'g'), `\/gw ${cmd}`);
        });

        // Also fix `graphward` as a CLI name in tests, e.g. "every tool-backed skill names its backing command"
        content = content.replace(/graphward skill/g, 'gw skill');
        
        if (content !== original) {
            fs.writeFileSync(file, content, 'utf8');
            console.log(`Fixed commands in ${file}`);
        }
    }
});
