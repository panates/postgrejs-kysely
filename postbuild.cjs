const fs = require('node:fs');
const path = require('node:path');

function postBuild() {
  const projectRoot = process.cwd();
  const json = JSON.parse(
    fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf-8'),
  );

  const buildDir = path.join(projectRoot, 'build');
  if (!fs.existsSync(buildDir)) throw new Error('Build directory not found');

  json.type = 'module';
  delete json.private;
  delete json.scripts;
  delete json.devDependencies;

  fs.writeFileSync(
    path.resolve(buildDir, 'package.json'),
    JSON.stringify(json, undefined, 2),
    'utf-8',
  );
  for (const file of ['README.md', 'CHANGELOG.md', 'LICENSE']) {
    const src = path.resolve('./' + file);
    if (fs.existsSync(src)) fs.copyFileSync(src, path.resolve(buildDir, file));
  }
}

postBuild();
