import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Loads dist with require, exactly like n8n's community loader; a throwing field
// initialiser there surfaces in n8n as "Class could not be found".
const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const req = createRequire(join(root, 'package.json'));
const pkg = req('./package.json');

test('every class listed in package.json loads and instantiates', () => {
	for (const file of [...pkg.n8n.nodes, ...pkg.n8n.credentials]) {
		const mod = req(`./${file}`);
		const [Cls] = Object.values(mod).filter((v) => typeof v === 'function' && v.prototype);
		assert.ok(Cls, `${file} exports no class`);
		assert.ok(new Cls(), `${file} does not instantiate`);
	}
});

test('node wiring matches what n8n expects', () => {
	const { Binance } = req('./dist/nodes/Binance/Binance.node.js');
	const node = new Binance();
	assert.deepEqual(node.description.inputs, ['main']);
	assert.deepEqual(node.description.outputs, ['main']);
	const [cred] = node.description.credentials;
	assert.equal(typeof node.methods.credentialTest[cred.testedBy], 'function');
	const account = node.description.properties.find(
		(p) => p.name === 'operation' && p.displayOptions?.show?.resource?.[0] === 'account',
	);
	assert.ok(account.options.some((o) => o.value === 'getTrades'));
});
