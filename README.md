# @munin92/n8n-nodes-binance

Read-only n8n community node for the Binance API. It cannot place orders or withdraw, and its
credential test refuses API keys that could.

| Resource | Operation | Endpoint |
|---|---|---|
| Account | Get All Holdings | Spot + Funding + Simple Earn (flexible, locked), one item per asset and wallet |
| Account | Get Balances | `GET /api/v3/account` (non-zero balances) |
| Account | Get Wallet Overview | `GET /sapi/v1/asset/wallet/balance`, every wallet in BTC |
| Account | Get Trades | `GET /api/v3/myTrades`, all trades of one symbol, paged by `fromId` |
| Wallet | Get Buy Crypto History | `GET /sapi/v1/fiat/payments` (Buy Crypto with card/balance), 30-day windows |
| Wallet | Get Convert History | `GET /sapi/v1/convert/tradeFlow`, 30-day windows |
| Wallet | Get Deposits | `GET /sapi/v1/capital/deposit/hisrec`, walked in 90-day windows |
| Wallet | Get Withdrawals | `GET /sapi/v1/capital/withdraw/history`, walked in 90-day windows |
| Market Data | Get Klines | `GET /api/v3/klines`, each candle with a volume-weighted average price |

Every operation emits one item per row. Rate limits (429/418) are retried after `Retry-After`;
a clock outside Binance's receive window (`-1021`) is corrected once from the server time.

## Credential

Create a Binance API key with **Enable Reading** only, then enter key and secret in the
*Binance API* credential. No runtime dependencies.

## Install

In n8n: *Settings → Community Nodes → Install* `@munin92/n8n-nodes-binance`.
