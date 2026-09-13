const fs = require('fs');
const path = require('path');

const dir = process.cwd();

function walkDirs(dir) {
    let results = [];
    const list = fs.readdirSync(dir);
    list.forEach(function(file) {
        file = path.join(dir, file);
        const stat = fs.statSync(file);
        if (stat && stat.isDirectory()) {
            if (!file.includes('node_modules') && !file.includes('.git') && !file.includes('dist')) {
                results = results.concat(walkDirs(file));
                results.push(file); // post-order traversal
            }
        }
    });
    return results;
}

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

// Rename files first
const files = walkFiles(dir);
files.forEach(file => {
    const dirName = path.dirname(file);
    const baseName = path.basename(file);
    let newBaseName = baseName;

    newBaseName = newBaseName.replace(/engineering-intelligence-blueprint\.md/g, 'graphward-blueprint.md');
    newBaseName = newBaseName.replace(/sync-engineering-intelligence\.md/g, 'sync-graphward.md');
    newBaseName = newBaseName.replace(/initialize-engineering-intelligence\.md/g, 'initialize-graphward.md');
    newBaseName = newBaseName.replace(/engineering-intelligence\.mdc/g, 'graphward.mdc');
    newBaseName = newBaseName.replace(/engineering-intelligence\.md/g, 'graphward.md');
    newBaseName = newBaseName.replace(/ei\.config\.json/g, 'gw.config.json');

    if (newBaseName !== baseName) {
        fs.renameSync(file, path.join(dirName, newBaseName));
        console.log(`Renamed file ${baseName} to ${newBaseName}`);
    }
});

// Rename directories
const dirs = walkDirs(dir);
dirs.forEach(d => {
    const dirName = path.dirname(d);
    const baseName = path.basename(d);
    let newBaseName = baseName;

    newBaseName = newBaseName.replace(/engineering-intelligence-skill/g, 'graphward-skill');
    newBaseName = newBaseName.replace(/engineering-intelligence/g, 'graphward');
    newBaseName = newBaseName.replace(/initialize-engineering-intelligence/g, 'initialize-graphward');
    newBaseName = newBaseName.replace(/sync-engineering-intelligence/g, 'sync-graphward');
    newBaseName = newBaseName.replace(/\.engineering-intelligence/g, '.graphward');

    if (newBaseName !== baseName) {
        fs.renameSync(d, path.join(dirName, newBaseName));
        console.log(`Renamed dir ${baseName} to ${newBaseName}`);
    }
});
