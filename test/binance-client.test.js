const test = require('node:test');
const assert = require('node:assert');
const {
	BinanceClient,
	BinanceApiError,
	sign,
	collectTrades,
	collectWindows,
	DAY_MS,
} = require('../dist/nodes/Binance/BinanceClient.js');
const { writeRights, kline, toMillis } = require('../dist/nodes/Binance/Binance.node.js');

const noWait = async () => {};
const ok = (body) => ({ statusCode: 200, headers: {}, body });

test('signature matches the HMAC example in the Binance spot docs', () => {
	assert.strictEqual(
		sign(
			'symbol=LTCBTC&side=BUY&type=LIMIT&timeInForce=GTC&quantity=1&price=0.1&recvWindow=5000&timestamp=1499827319559',
			'NhqPtmdSJYdKjVHjA7PZj4Mge3R5YNiP1e3UZjInClVN65XAbvqqM6A7H5fATj0j',
		),
		'c8db56825ae71d6d79447849e617115f4a920fa2acdcab2b053c4b2838bd6b71',
	);
});

test('signed calls carry key header, timestamp, recvWindow and a valid signature', async () => {
	const seen = [];
	const client = new BinanceClient(async (r) => (seen.push(r), ok([])), 'key', 'secret', noWait, () => 1700000000000);
	await client.signed('/api/v3/myTrades', { symbol: 'ETHEUR', fromId: 0, limit: 1000, empty: '' });
	const url = new URL(seen[0].url);
	assert.strictEqual(url.pathname, '/api/v3/myTrades');
	assert.strictEqual(seen[0].headers['X-MBX-APIKEY'], 'key');
	assert.strictEqual(url.searchParams.get('timestamp'), '1700000000000');
	assert.strictEqual(url.searchParams.get('fromId'), '0');
	assert.strictEqual(url.searchParams.has('empty'), false);
	const [query, signature] = url.search.slice(1).split('&signature=');
	assert.strictEqual(signature, sign(query, 'secret'));
});

test('public calls are unsigned GETs', async () => {
	const seen = [];
	const client = new BinanceClient(async (r) => (seen.push(r), ok([])));
	await client.public('/api/v3/klines', { symbol: 'ETHEUR', interval: '1d' });
	assert.strictEqual(seen[0].url, 'https://api.binance.com/api/v3/klines?symbol=ETHEUR&interval=1d');
	assert.deepStrictEqual(seen[0].headers, {});
});

test('429 waits for Retry-After and retries; other errors throw with the Binance code', async () => {
	const waits = [];
	let n = 0;
	const client = new BinanceClient(
		async () => (n++ < 2 ? { statusCode: 429, headers: { 'retry-after': '3' }, body: {} } : ok({ done: 1 })),
		'k',
		's',
		async (ms) => waits.push(ms),
	);
	assert.deepStrictEqual(await client.signed('/api/v3/account'), { done: 1 });
	assert.deepStrictEqual(waits, [3000, 3000]);

	let calls = 0;
	const failing = new BinanceClient(
		async () => (calls++, { statusCode: 401, headers: {}, body: { code: -2015, msg: 'Invalid API-key' } }),
		'k',
		's',
		noWait,
	);
	await assert.rejects(
		failing.signed('/api/v3/account'),
		(e) => e instanceof BinanceApiError && e.code === -2015 && /Invalid API-key/.test(e.message),
	);
	assert.strictEqual(calls, 1);
});

test('rate-limit retries are bounded', async () => {
	let calls = 0;
	const client = new BinanceClient(
		async () => {
			if (++calls > 20) throw new Error('retries are unbounded');
			return { statusCode: 418, headers: {}, body: { code: -1003 } };
		},
		'k',
		's',
		noWait,
	);
	await assert.rejects(client.signed('/api/v3/account'), /418/);
	assert.strictEqual(calls, 6);
});

test('-1021 resyncs the clock once from server time and retries', async () => {
	const stamps = [];
	let local = 1_000_000;
	const client = new BinanceClient(
		async (r) => {
			const url = new URL(r.url);
			if (url.pathname === '/api/v3/time') return ok({ serverTime: 1_005_000 });
			stamps.push(Number(url.searchParams.get('timestamp')));
			return stamps.length === 1
				? { statusCode: 400, headers: {}, body: { code: -1021, msg: 'Timestamp outside recvWindow' } }
				: ok({ fine: true });
		},
		'k',
		's',
		noWait,
		() => local,
	);
	assert.deepStrictEqual(await client.signed('/api/v3/account'), { fine: true });
	assert.deepStrictEqual(stamps, [1_000_000, 1_005_000]);

	const stubborn = new BinanceClient(
		async (r) =>
			new URL(r.url).pathname === '/api/v3/time'
				? ok({ serverTime: 1 })
				: { statusCode: 400, headers: {}, body: { code: -1021 } },
		'k',
		's',
		noWait,
	);
	await assert.rejects(stubborn.signed('/api/v3/account'), (e) => e.code === -1021);
});

test('trades page by fromId until a short page', async () => {
	const from = [];
	const rows = await collectTrades(async (fromId) => {
		from.push(fromId);
		const size = from.length < 3 ? 1000 : 7;
		return Array.from({ length: size }, (_, k) => ({ id: fromId + k }));
	});
	assert.deepStrictEqual(from, [0, 1000, 2000]);
	assert.strictEqual(rows.length, 2007);
});

test('history walks 90-day windows and pages by offset inside a window', async () => {
	const calls = [];
	const since = Date.UTC(2026, 0, 1);
	const until = since + 200 * DAY_MS;
	const rows = await collectWindows(
		async (start, end, offset) => {
			calls.push([start, end, offset]);
			return Array.from({ length: calls.length === 1 ? 1000 : 3 }, () => ({}));
		},
		since,
		until,
	);
	assert.deepStrictEqual(
		calls.map((c) => [(c[0] - since) / DAY_MS, c[2]]),
		[[0, 0], [0, 1000], [90, 0], [180, 0]],
	);
	for (const [start, end] of calls) assert.ok(end - start < 90 * DAY_MS && end <= until);
	assert.strictEqual(rows.length, 1009);
});

test('keys that can move funds are rejected, read-only keys pass', () => {
	assert.deepStrictEqual(writeRights({ enableReading: true, enableWithdrawals: false }), []);
	assert.deepStrictEqual(
		writeRights({ enableReading: true, enableSpotAndMarginTrading: true, enableWithdrawals: true }),
		['enableWithdrawals', 'enableSpotAndMarginTrading'],
	);
});

test('klines carry a volume-weighted average price', () => {
	const k = kline([1, '10', '12', '9', '11', '2', 2, '21', 5]);
	assert.strictEqual(k.vwap, 10.5);
	assert.strictEqual(kline([1, '1', '1', '1', '11', '0', 2, '0', 0]).vwap, 11);
});

test('dates: empty uses the fallback, garbage is rejected', () => {
	assert.strictEqual(toMillis('', 42), 42);
	assert.strictEqual(toMillis('2026-09-22T00:00:00Z', 0), Date.UTC(2026, 8, 22));
	assert.throws(() => toMillis('nope', 0), /Not a valid date/);
});
