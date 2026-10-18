import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

// Phaser (~1,5 МБ) должен догружаться отдельно; статический импорт в главном коде вернёт его в основной файл.
test('Phaser и сцена не импортируются статически из кода интерфейса', () => {
  for (const file of ['src/App.tsx', 'src/main.tsx', 'src/taskEvents.ts', 'src/types.ts']) {
    const source = read(file);
    assert.doesNotMatch(source, /^import\s+(?!type\b)[^;]*from\s+['"]phaser['"]/m, `${file}: статический импорт phaser`);
    assert.doesNotMatch(source, /^import\s+(?!type\b)[^;]*from\s+['"]\.\/(?:OfficeScene|officeGame)['"]/m, `${file}: статический импорт сцены`);
  }
  assert.match(read('src/App.tsx'), /import\('\.\/officeGame'\)/);
});
