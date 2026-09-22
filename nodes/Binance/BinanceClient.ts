import { createHmac } from 'node:crypto';
import { type IDataObject, sleep } from 'n8n-workflow';

export const BINANCE_API = 'https://api.binance.com';
const RETRIES = 5;
const DEFAULT_WAIT_MS = 10_000;
const RECV_WINDOW = 10_000;

export interface BinanceRequest {
	method: 'GET' | 'POST';
	url: string;
	headers: Record<string, string>;
}

export interface BinanceResponse {
	statusCode: number;
	headers: Record<string, string | string[] | undefined>;
	body: unknown;
}

export type BinanceTransport = (request: BinanceRequest) => Promise<BinanceResponse>;

export class BinanceApiError extends Error {
	constructor(
		readonly status: number,
		readonly code: number | undefined,
		message: string,
	) {
		super(message);
		this.name = 'BinanceApiError';
	}
}

export function sign(query: string, secret: string): string {
	return createHmac('sha256', secret).update(query).digest('hex');
}

export function encode(params: IDataObject): string {
	const query = new URLSearchParams();
	for (const [key, value] of Object.entries(params)) {
		if (value !== undefined && value !== null && value !== '') query.append(key, String(value));
	}
	return query.toString();
}

function retryAfterMs(headers: BinanceResponse['headers']): number {
	const raw = headers['retry-after'];
	const seconds = Number(Array.isArray(raw) ? raw[0] : raw);
	return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : DEFAULT_WAIT_MS;
}

export class BinanceClient {
	private clockOffsetMs = 0;

	constructor(
		private readonly transport: BinanceTransport,
		private readonly key = '',
		private readonly secret = '',
		private readonly wait: (ms: number) => Promise<void> = sleep,
		private readonly now: () => number = Date.now,
	) {}

	async public(path: string, params: IDataObject = {}): Promise<unknown> {
		const query = encode(params);
		return await this.send(() => ({
			method: 'GET',
			url: `${BINANCE_API}${path}${query ? `?${query}` : ''}`,
			headers: {},
		}));
	}

	// Binance takes POST parameters in the query string too, so both methods sign the same way.
	async signed(
		path: string,
		params: IDataObject = {},
		method: BinanceRequest['method'] = 'GET',
	): Promise<unknown> {
		const build = (): BinanceRequest => {
			const query = encode({
				...params,
				recvWindow: RECV_WINDOW,
				timestamp: this.now() + this.clockOffsetMs,
			});
			return {
				method,
				url: `${BINANCE_API}${path}?${query}&signature=${sign(query, this.secret)}`,
				headers: { 'X-MBX-APIKEY': this.key },
			};
		};
		let result = await this.attempt(build);
		// -1021: our clock is outside Binance's recvWindow; measure the offset once and retry.
		if (result.error?.code === -1021) {
			const time = (await this.public('/api/v3/time')) as { serverTime?: number };
			if (typeof time?.serverTime === 'number') this.clockOffsetMs = time.serverTime - this.now();
			result = await this.attempt(build);
		}
		if (result.error) throw result.error;
		return result.body;
	}

	private async send(build: () => BinanceRequest): Promise<unknown> {
		const result = await this.attempt(build);
		if (result.error) throw result.error;
		return result.body;
	}

	// 429 is a rate limit, 418 an IP ban for ignoring one; both carry Retry-After.
	private async attempt(
		build: () => BinanceRequest,
	): Promise<{ body?: unknown; error?: BinanceApiError }> {
		for (let attempt = 0; ; attempt++) {
			const response = await this.transport(build());
			if (response.statusCode < 400) return { body: response.body };
			const limited = response.statusCode === 429 || response.statusCode === 418;
			if (limited && attempt < RETRIES) {
				await this.wait(retryAfterMs(response.headers));
				continue;
			}
			const body = (response.body ?? {}) as { code?: number; msg?: string };
			return {
				error: new BinanceApiError(
					response.statusCode,
					body.code,
					`Binance ${response.statusCode}${body.code !== undefined ? ` (${body.code})` : ''}: ${body.msg ?? 'request failed'}`,
				),
			};
		}
	}
}

export const DAY_MS = 86_400_000;
const WINDOW_MS = 90 * DAY_MS;

// Deposit and withdrawal history only answer within 90-day windows, 1000 rows per page.
export async function collectWindows(
	fetchPage: (startTime: number, endTime: number, offset: number) => Promise<IDataObject[]>,
	since: number,
	until: number,
): Promise<IDataObject[]> {
	const rows: IDataObject[] = [];
	for (let start = since; start < until; start += WINDOW_MS) {
		const end = Math.min(start + WINDOW_MS - 1, until);
		for (let offset = 0; ; offset += 1000) {
			const page = await fetchPage(start, end, offset);
			rows.push(...page);
			if (page.length < 1000) break;
		}
	}
	return rows;
}

// myTrades pages by trade id; fromId=0 starts at the account's first trade for the symbol.
export async function collectTrades(
	fetchPage: (fromId: number) => Promise<IDataObject[]>,
): Promise<IDataObject[]> {
	const rows: IDataObject[] = [];
	for (let fromId = 0; ;) {
		const page = await fetchPage(fromId);
		rows.push(...page);
		if (page.length < 1000) break;
		fromId = Number(page[page.length - 1].id) + 1;
	}
	return rows;
}

// Simple Earn positions page by `current` (1-based) and `size` (max 100) and report `total`.
export async function collectEarnPages(
	fetchPage: (current: number, size: number) => Promise<{ rows?: IDataObject[]; total?: number }>,
): Promise<IDataObject[]> {
	const rows: IDataObject[] = [];
	for (let current = 1; ; current++) {
		const page = await fetchPage(current, 100);
		const got = page.rows ?? [];
		rows.push(...got);
		if (got.length < 100 || rows.length >= (page.total ?? Infinity)) break;
	}
	return rows;
}
