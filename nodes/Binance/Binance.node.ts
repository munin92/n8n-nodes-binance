import {
	ApplicationError,
	ICredentialTestFunctions,
	ICredentialsDecrypted,
	IDataObject,
	IExecuteFunctions,
	INodeCredentialTestResult,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
	JsonObject,
	NodeApiError,
	NodeConnectionType,
	NodeOperationError,
} from 'n8n-workflow';

import {
	BinanceApiError,
	BinanceClient,
	BinanceResponse,
	collectEarnPages,
	collectTrades,
	collectWindows,
	DAY_MS,
} from './BinanceClient';

// Binance launched in July 2017; nothing in an account can be older.
const BINANCE_START = Date.UTC(2017, 6, 1);

// A read-only node must refuse keys that can move money, even if it never calls those endpoints.
const WRITE_RIGHTS = [
	'enableWithdrawals',
	'enableSpotAndMarginTrading',
	'enableInternalTransfer',
	'permitsUniversalTransfer',
	'enableMargin',
	'enableFutures',
	'enablePortfolioMarginTrading',
	'enableVanillaOptions',
];

export function writeRights(restrictions: IDataObject): string[] {
	return WRITE_RIGHTS.filter((right) => restrictions[right] === true);
}

export function toMillis(value: unknown, fallback: number): number {
	if (value === undefined || value === null || value === '') return fallback;
	const ms = new Date(String(value)).getTime();
	if (Number.isNaN(ms)) throw new ApplicationError(`Not a valid date: ${value}`);
	return ms;
}

export function kline(row: unknown[]): IDataObject {
	const [openTime, open, high, low, close, volume, closeTime, quoteVolume, trades] = row as [
		number,
		string,
		string,
		string,
		string,
		string,
		number,
		string,
		number,
	];
	const vwap = Number(volume) > 0 ? Number(quoteVolume) / Number(volume) : Number(close);
	return { openTime, open, high, low, close, volume, closeTime, quoteVolume, trades, vwap };
}

// The spot account alone misses coins bought via "Buy Crypto" (Funding) or parked in Simple Earn.
export async function allHoldings(client: BinanceClient): Promise<IDataObject[]> {
	const rows: IDataObject[] = [];
	const add = (asset: unknown, amount: unknown, wallet: string, extra: IDataObject = {}) => {
		const value = Number(amount);
		if (asset && value > 0) rows.push({ asset: String(asset), amount: value, wallet, ...extra });
	};
	const spot = (await client.signed('/api/v3/account', { omitZeroBalances: true })) as {
		balances?: IDataObject[];
	};
	for (const b of spot.balances ?? []) add(b.asset, Number(b.free) + Number(b.locked), 'spot');
	const funding = (await client.signed(
		'/sapi/v1/asset/get-funding-asset',
		{},
		'POST',
	)) as IDataObject[];
	for (const f of funding ?? [])
		add(f.asset, Number(f.free) + Number(f.locked) + Number(f.freeze), 'funding');
	const flexible = await collectEarnPages(
		async (current, size) =>
			(await client.signed('/sapi/v1/simple-earn/flexible/position', { current, size })) as {
				rows?: IDataObject[];
				total?: number;
			},
	);
	for (const f of flexible) add(f.asset, f.totalAmount, 'earnFlexible');
	const locked = await collectEarnPages(
		async (current, size) =>
			(await client.signed('/sapi/v1/simple-earn/locked/position', { current, size })) as {
				rows?: IDataObject[];
				total?: number;
			},
	);
	for (const l of locked) add(l.asset, l.amount, 'earnLocked', { positionId: l.positionId });
	return rows;
}

export class Binance implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Binance',
		name: 'binance',
		icon: 'file:binance.svg',
		group: ['input'],
		version: 1,
		usableAsTool: true,
		subtitle: '={{$parameter["operation"] + ": " + $parameter["resource"]}}',
		description: 'Read balances, spot trades, deposits, withdrawals and klines from Binance',
		defaults: {
			name: 'Binance',
		},
		// String literals: an older shared n8n-workflow copy lacks the constant, which n8n reports as "Class could not be found".
		inputs: ['main' as NodeConnectionType],
		outputs: ['main' as NodeConnectionType],
		credentials: [
			{
				name: 'binanceApi',
				required: true,
				testedBy: 'binanceApiTest',
			},
		],
		properties: [
			{
				displayName: 'Resource',
				name: 'resource',
				type: 'options',
				noDataExpression: true,
				options: [
					{ name: 'Account', value: 'account' },
					{ name: 'Market Data', value: 'marketData' },
					{ name: 'Wallet', value: 'wallet' },
				],
				default: 'account',
			},
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: { show: { resource: ['account'] } },
				options: [
					{
						name: 'Get All Holdings',
						value: 'getAllHoldings',
						description: 'Spot, Funding and Simple Earn holdings, one item per asset and wallet',
						action: 'Get all holdings',
					},
					{
						name: 'Get Balances',
						value: 'getBalances',
						description: 'Non-zero spot balances, one item per asset',
						action: 'Get balances',
					},
					{
						name: 'Get Trades',
						value: 'getTrades',
						description: 'All spot trades for one symbol, one item per trade',
						action: 'Get trades',
					},
					{
						name: 'Get Wallet Overview',
						value: 'getWalletOverview',
						description: 'Balance of every Binance wallet (Spot, Funding, Earn, …) in BTC',
						action: 'Get wallet overview',
					},
				],
				default: 'getBalances',
			},
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: { show: { resource: ['wallet'] } },
				options: [
					{
						name: 'Get Buy Crypto History',
						value: 'getBuyHistory',
						description: 'Crypto bought or sold for fiat ("Buy Crypto"), one item per payment',
						action: 'Get buy crypto history',
					},
					{
						name: 'Get Convert History',
						value: 'getConvertHistory',
						description: 'Convert trades between two assets, one item per conversion',
						action: 'Get convert history',
					},
					{
						name: 'Get Deposits',
						value: 'getDeposits',
						description: 'Crypto deposit history, one item per deposit',
						action: 'Get deposits',
					},
					{
						name: 'Get Withdrawals',
						value: 'getWithdrawals',
						description: 'Crypto withdrawal history, one item per withdrawal',
						action: 'Get withdrawals',
					},
				],
				default: 'getDeposits',
			},
			{
				displayName: 'Operation',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				displayOptions: { show: { resource: ['marketData'] } },
				options: [
					{
						name: 'Get Klines',
						value: 'getKlines',
						description: 'Candles for a symbol, one item per candle, with VWAP',
						action: 'Get klines',
					},
				],
				default: 'getKlines',
			},
			{
				displayName: 'Symbol',
				name: 'symbol',
				type: 'string',
				displayOptions: { show: { operation: ['getTrades', 'getKlines'] } },
				default: '',
				required: true,
				placeholder: 'ETHEUR',
				description: 'Trading pair without separator, e.g. ETHEUR or BTCEUR',
			},
			{
				displayName: 'Since',
				name: 'since',
				type: 'dateTime',
				displayOptions: {
					show: {
						operation: ['getDeposits', 'getWithdrawals', 'getBuyHistory', 'getConvertHistory'],
					},
				},
				default: '',
				description:
					'Start of the history to read. Empty reads everything since Binance launched (July 2017).',
			},
			{
				displayName: 'Direction',
				name: 'direction',
				type: 'options',
				displayOptions: { show: { operation: ['getBuyHistory'] } },
				options: [
					{ name: 'Buy (Fiat → Crypto)', value: 0 },
					{ name: 'Sell (Crypto → Fiat)', value: 1 },
				],
				default: 0,
			},
			{
				displayName: 'Interval',
				name: 'interval',
				type: 'options',
				displayOptions: { show: { operation: ['getKlines'] } },
				options: [
					{ name: '1 Day', value: '1d' },
					{ name: '1 Hour', value: '1h' },
					{ name: '1 Week', value: '1w' },
					{ name: '4 Hours', value: '4h' },
				],
				default: '1d',
			},
			{
				displayName: 'Start Time',
				name: 'startTime',
				type: 'dateTime',
				displayOptions: { show: { operation: ['getKlines'] } },
				default: '',
				description: 'First candle to return. Empty returns the most recent candles.',
			},
			{
				displayName: 'Limit',
				name: 'limit',
				type: 'number',
				displayOptions: { show: { operation: ['getKlines'] } },
				typeOptions: { minValue: 1, maxValue: 1000 },
				default: 500,
				description: 'Max number of results to return',
			},
		],
	};

	methods = {
		credentialTest: {
			async binanceApiTest(
				this: ICredentialTestFunctions,
				credential: ICredentialsDecrypted,
			): Promise<INodeCredentialTestResult> {
				const data = (credential.data ?? {}) as IDataObject;
				try {
					const client = new BinanceClient(
						async (req) => {
							// eslint-disable-next-line @n8n/community-nodes/no-deprecated-workflow-functions
							const res = (await this.helpers.request({
								method: req.method,
								uri: req.url,
								headers: req.headers,
								json: true,
								resolveWithFullResponse: true,
								simple: false,
							})) as { statusCode: number; headers: BinanceResponse['headers']; body: unknown };
							return { statusCode: res.statusCode, headers: res.headers, body: res.body };
						},
						String(data.apiKey ?? ''),
						String(data.apiSecret ?? ''),
					);
					const rights = writeRights(
						(await client.signed('/sapi/v1/account/apiRestrictions')) as IDataObject,
					);
					if (rights.length) {
						return {
							status: 'Error',
							message: `This key can move funds (${rights.join(', ')}). Create one with "Enable Reading" only.`,
						};
					}
					return { status: 'OK', message: 'Connected, read-only key' };
				} catch (error) {
					return { status: 'Error', message: (error as Error).message };
				}
			},
		},
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const returnData: INodeExecutionData[] = [];

		const credentials = await this.getCredentials('binanceApi');
		const client = new BinanceClient(
			async (req) => {
				const res = (await this.helpers.httpRequest({
					method: req.method,
					url: req.url,
					headers: req.headers,
					json: true,
					returnFullResponse: true,
					ignoreHttpStatusErrors: true,
					timeout: 60_000,
				})) as { statusCode: number; headers: BinanceResponse['headers']; body: unknown };
				return { statusCode: res.statusCode, headers: res.headers, body: res.body };
			},
			String(credentials.apiKey ?? ''),
			String(credentials.apiSecret ?? ''),
		);

		for (let i = 0; i < items.length; i++) {
			try {
				const operation = this.getNodeParameter('operation', i) as string;
				let rows: IDataObject[];

				switch (operation) {
					case 'getBalances': {
						const account = (await client.signed('/api/v3/account', {
							omitZeroBalances: true,
						})) as { balances?: IDataObject[] };
						rows = (account.balances ?? []).map((b) => ({
							...b,
							total: Number(b.free) + Number(b.locked),
						}));
						break;
					}

					case 'getWalletOverview': {
						rows = (await client.signed('/sapi/v1/asset/wallet/balance')) as IDataObject[];
						break;
					}

					case 'getAllHoldings': {
						rows = await allHoldings(client);
						break;
					}

					case 'getTrades': {
						const symbol = String(this.getNodeParameter('symbol', i)).trim().toUpperCase();
						rows = await collectTrades(
							async (fromId) =>
								(await client.signed('/api/v3/myTrades', {
									symbol,
									fromId,
									limit: 1000,
								})) as IDataObject[],
						);
						break;
					}

					case 'getDeposits':
					case 'getWithdrawals': {
						const since = toMillis(this.getNodeParameter('since', i, ''), BINANCE_START);
						const path =
							operation === 'getDeposits'
								? '/sapi/v1/capital/deposit/hisrec'
								: '/sapi/v1/capital/withdraw/history';
						rows = await collectWindows(
							async (startTime, endTime, pageIndex) =>
								(await client.signed(path, {
									startTime,
									endTime,
									offset: pageIndex * 1000,
									limit: 1000,
								})) as IDataObject[],
							since,
							Date.now(),
						);
						break;
					}

					case 'getBuyHistory': {
						const since = toMillis(this.getNodeParameter('since', i, ''), BINANCE_START);
						const transactionType = this.getNodeParameter('direction', i, 0) as number;
						rows = await collectWindows(
							async (beginTime, endTime, pageIndex) => {
								const res = (await client.signed('/sapi/v1/fiat/payments', {
									transactionType,
									beginTime,
									endTime,
									page: pageIndex + 1,
									rows: 500,
								})) as { data?: IDataObject[] };
								return res?.data ?? [];
							},
							since,
							Date.now(),
							30 * DAY_MS,
							500,
						);
						break;
					}

					case 'getConvertHistory': {
						const since = toMillis(this.getNodeParameter('since', i, ''), BINANCE_START);
						// The endpoint has no paging; 1000 per 30-day window is its ceiling.
						rows = await collectWindows(
							async (startTime, endTime) => {
								const res = (await client.signed('/sapi/v1/convert/tradeFlow', {
									startTime,
									endTime,
									limit: 1000,
								})) as { list?: IDataObject[] };
								return res?.list ?? [];
							},
							since,
							Date.now(),
							30 * DAY_MS,
							Number.POSITIVE_INFINITY,
						);
						break;
					}

					case 'getKlines': {
						const symbol = String(this.getNodeParameter('symbol', i)).trim().toUpperCase();
						const raw = (await client.public('/api/v3/klines', {
							symbol,
							interval: this.getNodeParameter('interval', i) as string,
							startTime: this.getNodeParameter('startTime', i, '')
								? toMillis(this.getNodeParameter('startTime', i), 0)
								: undefined,
							limit: this.getNodeParameter('limit', i, 500) as number,
						})) as unknown[][];
						rows = raw.map(kline);
						break;
					}

					default:
						throw new NodeOperationError(
							this.getNode(),
							`The operation "${operation}" is not known!`,
							{
								itemIndex: i,
							},
						);
				}

				for (const json of rows) returnData.push({ json, pairedItem: { item: i } });
			} catch (error) {
				if (this.continueOnFail()) {
					returnData.push({ json: { error: (error as Error).message }, pairedItem: { item: i } });
					continue;
				}
				if (error instanceof BinanceApiError) {
					throw new NodeApiError(
						this.getNode(),
						{ status: error.status, code: error.code ?? null } as JsonObject,
						{ message: error.message, itemIndex: i },
					);
				}
				throw new NodeOperationError(this.getNode(), error as Error, { itemIndex: i });
			}
		}

		return [returnData];
	}
}
