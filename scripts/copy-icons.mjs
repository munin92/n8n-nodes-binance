import { cp, mkdir } from 'node:fs/promises';
const dir = 'dist/nodes/Binance';
await mkdir(dir, { recursive: true });
await cp('nodes/Binance/binance.svg', `${dir}/binance.svg`);
